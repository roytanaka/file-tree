import { describe, expect, test } from 'claude-code/testing'

import { scan } from '../hooks/scan'
import type { Ports } from '../hooks/scan'

type Result = { exitCode: number; stdout: string; stderr: string }
const ok = (stdout = ''): Result => ({ exitCode: 0, stdout, stderr: '' })

// An fs from a flat map of files under /repo; a `null` value is a folder that can't be read.
function fsPorts(tree: Record<string, string | null>): Ports {
  const children = (abs: string) => {
    const prefix = abs === '/repo' ? '' : abs.slice('/repo/'.length) + '/'
    const seen = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(tree)) {
      if (!path.startsWith(prefix) || path === prefix.slice(0, -1)) continue
      const [name, ...rest] = path.slice(prefix.length).split('/')
      seen.set(name!, rest.length > 0 || tree[path] === null ? 'dir' : 'file')
    }
    return [...seen].map(([name, kind]) => ({ name, kind }))
  }
  return {
    cwd: '/repo',
    run: async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' }),
    list: async abs => {
      if (tree[abs.slice('/repo/'.length)] === null) throw new Error('EACCES')
      return children(abs)
    },
    read: async abs => {
      const text = tree[abs.slice('/repo/'.length)]
      if (typeof text !== 'string') throw new Error('ENOENT')
      return text
    },
  }
}

// git answering by subcommand; anything not given falls back to an empty success.
function gitPorts(answers: { ls?: Result; ignored?: Result; status?: Result }): Ports & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    cwd: '/repo/sub',
    run: async argv => {
      calls.push(argv)
      if (argv[1] === 'rev-parse') return ok('/repo\n')
      if (argv.includes('--ignored')) return answers.ignored ?? ok()
      if (argv[1] === 'ls-files') return answers.ls ?? ok()
      return answers.status ?? ok()
    },
    list: async () => { throw new Error('fs should not be touched in a git repo') },
    read: async () => { throw new Error('fs should not be touched in a git repo') },
  }
}

describe('fs walk', () => {
  test('nested .gitignore rules are scoped; ignored folders end in /', async () => {
    const snap = await scan(fsPorts({
      '.gitignore': 'dist/\n',
      'a.ts': '',
      'dist/out.js': '',
      'pkg/.gitignore': '*.tmp\n',
      'pkg/x.tmp': '',
      'pkg/y.ts': '',
      'other/x.tmp': '',
    }), { includeIgnored: true })
    expect(snap).toEqual({
      root: '/repo',
      files: ['.gitignore', 'a.ts', 'pkg/.gitignore', 'pkg/y.ts', 'other/x.tmp'],
      ignored: ['dist/', 'pkg/x.tmp'],
      status: {},
      error: '',
    })
  })

  test('skips .git, node_modules and .DS_Store', async () => {
    const snap = await scan(fsPorts({
      '.git/HEAD': '', 'node_modules/x/index.js': '', '.DS_Store': '', 'src/.DS_Store': '', 'src/a.ts': '',
    }), { includeIgnored: true })
    expect(snap.files).toEqual(['src/a.ts'])
    expect(snap.ignored).toEqual([])
  })

  test('includeIgnored: false leaves ignored empty', async () => {
    const snap = await scan(fsPorts({ '.gitignore': '*.log\n', 'a.log': '', 'b.ts': '' }), { includeIgnored: false })
    expect(snap.files).toEqual(['.gitignore', 'b.ts'])
    expect(snap.ignored).toEqual([])
  })

  test('an unreadable folder is skipped without failing the walk', async () => {
    const snap = await scan(fsPorts({ locked: null, 'a.ts': '' }), { includeIgnored: true })
    expect(snap.files).toEqual(['a.ts'])
  })
})

describe('git', () => {
  test('lists files from the repo top, collapses ignored folders, maps status', async () => {
    const ports = gitPorts({
      ls: ok('a.ts\0src/b.ts\0a.ts\0.DS_Store\0'),
      ignored: ok('node_modules/\0node_modules/x.js\0debug.log\0'),
      status: ok(' M src/b.ts\0?? a.ts\0'),
    })
    expect(await scan(ports, { includeIgnored: true })).toEqual({
      root: '/repo',
      files: ['a.ts', 'src/b.ts'],
      ignored: ['node_modules/', 'debug.log'],
      status: { 'src/b.ts': 'M', 'a.ts': 'U' },
      error: '',
    })
  })

  test('includeIgnored: false never asks git for ignored paths', async () => {
    const ports = gitPorts({ ls: ok('a.ts\0') })
    expect((await scan(ports, { includeIgnored: false })).ignored).toEqual([])
    expect(ports.calls.some(argv => argv.includes('--ignored'))).toBe(false)
  })

  test('a failed ls-files becomes the error; a failed status gives no marks', async () => {
    const snap = await scan(gitPorts({
      ls: { exitCode: 1, stdout: '', stderr: 'fatal: bad index\n' },
      status: { exitCode: 1, stdout: ' M a.ts\0', stderr: '' },
    }), { includeIgnored: true })
    expect(snap.error).toBe('fatal: bad index')
    expect(snap.status).toEqual({})
  })
})

describe('fallback', () => {
  test('rev-parse exiting non-zero or throwing walks the fs instead', async () => {
    const exits = fsPorts({ 'a.ts': '' })
    expect((await scan(exits, { includeIgnored: true })).files).toEqual(['a.ts'])
    const throws: Ports = { ...exits, run: async () => { throw new Error('git: not found') } }
    expect((await scan(throws, { includeIgnored: true })).files).toEqual(['a.ts'])
  })
})
