import { describe, expect, mock, test } from 'claude-code/testing'

import { fileIcon } from '../hooks/icons'
import { ancestors, changedView, collapseIgnored, flatten, folderMarks, isIgnored, parseGitignore, parseStatus, relativeTo } from '../hooks/tree'

describe('gitignore', () => {
  const rules = parseGitignore('node_modules/\n*.log\n/dist\n!keep.log\nsrc/**/gen\n')
  test('ignores matching paths and honours negation', async () => {
    expect(isIgnored(rules, 'node_modules', true)).toBe(true)
    expect(isIgnored(rules, 'node_modules', false)).toBe(false)
    expect(isIgnored(rules, 'a/b/err.log', false)).toBe(true)
    expect(isIgnored(rules, 'keep.log', false)).toBe(false)
    expect(isIgnored(rules, 'dist', true)).toBe(true)
    expect(isIgnored(rules, 'pkg/dist', true)).toBe(false)
    expect(isIgnored(rules, 'src/a/b/gen', true)).toBe(true)
    expect(isIgnored(rules, 'src/main.ts', false)).toBe(false)
  })
  test('nested .gitignore rules are scoped to their folder', async () => {
    const nested = parseGitignore('*.tmp\n/out\n', 'pkg')
    expect(isIgnored(nested, 'pkg/x/a.tmp', false)).toBe(true)
    expect(isIgnored(nested, 'other/a.tmp', false)).toBe(false)
    expect(isIgnored(nested, 'pkg/out', true)).toBe(true)
  })
})

describe('tree', () => {
  const files = ['README.md', 'src/a.ts', 'src/lib/b.ts', 'docs/x.md']
  test('collapsed folders hide their children; dirs sort first', async () => {
    expect(flatten(files, new Set()).map(r => r.path)).toEqual(['docs', 'src', 'README.md'])
    expect(flatten(files, new Set(['src'])).map(r => r.path)).toEqual([
      'docs', 'src', 'src/lib', 'src/a.ts', 'README.md',
    ])
  })
  test('path helpers', async () => {
    expect(ancestors('src/lib/b.ts')).toEqual(['src', 'src/lib'])
    expect(relativeTo('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/repo', '/elsewhere/a.ts')).toBeUndefined()
  })
})

describe('git status', () => {
  test('porcelain -z maps to one mark per path', async () => {
    const z = ' M a.ts\0A  b.ts\0 D c.ts\0R  new.ts\0old.ts\0?? d/e.ts\0UU f.ts\0'
    expect(parseStatus(z)).toEqual({
      'a.ts': 'M', 'b.ts': 'A', 'c.ts': 'D', 'new.ts': 'R', 'd/e.ts': 'U', 'f.ts': 'C',
    })
  })
  test('folders take their strongest descendant mark', async () => {
    expect(folderMarks({ 'src/x/a.ts': 'U', 'src/b.ts': 'M', 'lib/c.ts': 'A' })).toEqual({
      src: 'M', 'src/x': 'U', lib: 'A',
    })
  })
})

describe('changed view', () => {
  test('keeps marked and edited files; their folders open unless folded', async () => {
    const files = ['a.ts', 'src/b.ts', 'src/lib/c.ts', 'docs/d.md']
    const view = changedView(files, { 'src/lib/c.ts': 'M' }, ['a.ts'], new Set(['src/lib']))
    expect(view.files).toEqual(['a.ts', 'src/lib/c.ts'])
    expect([...view.open]).toEqual(['src'])
  })
})

describe('ignored listing', () => {
  test('drops .DS_Store and anything git also lists under an ignored folder', async () => {
    expect(collapseIgnored(['.DS_Store', 'a/.DS_Store', 'a/.vscode/', 'a/.vscode/launch.json', 'node_modules/', 'x.log']))
      .toEqual(['a/.vscode/', 'node_modules/', 'x.log'])
  })
  test('an ignored folder flattens to a single row', async () => {
    expect(flatten(['src/a.ts', 'node_modules/'], new Set(['node_modules'])).map(r => r.path))
      .toEqual(['node_modules', 'src'])
  })
})

describe('icons', () => {
  test('names beat extensions; unknown files get the generic icon', async () => {
    expect(fileIcon('package.json').glyph).toBe('\u{e71e}')
    expect(fileIcon('data.json').glyph).toBe('\u{e60b}')
    expect(fileIcon('App.VUE').glyph).toBe('\u{e6a0}')
    expect(fileIcon('.eslintrc.js').glyph).toBe('\u{e655}')
    expect(fileIcon('Makefile').glyph).toBe('\u{f15b}')
    expect(fileIcon('.bashrc').glyph).toBe('\u{f15b}')
  })
})

const PANE = {
  component: 'Pane',
  requestId: 'file-tree',
  props: {
    title: 'Files', isFocused: false, bodyColumns: 40, placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 }, view: {},
  },
} as const

test('pane highlights edited files and toggles folders', async ($, on) => {
  const panes: { id: string }[] = []
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  on('process.run', async (_, e) => {
    const argv = (e as { argv?: string[] }).argv ?? (e as unknown as string[][])[0] ?? []
    if (argv.includes('--ignored')) return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    const stdout =
      argv[1] === 'rev-parse' ? '/repo\n'
      : argv[1] === 'status' ? ' M src/b.ts\0?? top.md\0'
      : 'src/a.ts\0src/b.ts\0top.md\0'
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('ui.panes', async () => ({ value: panes }) as never)
  on('ui.open', async (_, e) => {
    panes.push({ id: e.id })
    return { value: undefined } as never
  })
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('turn.start', async (_, e) => ({ turnId: e.turnId }))

  await $.command.run({ command: 'tree', args: '' } as never)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'file-tree', surface, ...PANE })
    expect(await ui.find({ key: 'file:src/a.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ ●$/ })).toBeDefined()
    expect(await ui.find({ key: 'file:src/b.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 file edited this turn/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ M$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ U$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ •$/ })).toBeDefined()
    await ui.press({ key: 'dir:src' })
    expect(await ui.find({ key: 'file:src/b.ts' })).toBeUndefined()
    await ui.press({ key: 'dir:src' })
    await ui.unmount()
  }

  const desk = await $.ui.mount({ plugin: 'file-tree', surface: 'desktop', ...PANE })
  expect(await desk.find({ type: 'Text', text: /\u{e628}/u })).toBeUndefined()
  await desk.unmount()
  const term = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  expect(await term.find({ type: 'Text', text: /\u{e628}/u })).toBeDefined()
  await term.unmount()

  await $.turn.start({ text: 'again', turnId: 't2' } as never)
  const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /●/ })).toBeUndefined()
})

test('icons: none draws no glyphs', { options: { icons: 'none' } }, async ($, on) => {
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  on('process.run', async (_, e) => {
    const argv = (e as { argv?: string[] }).argv ?? (e as unknown as string[][])[0] ?? []
    if (argv.includes('--ignored')) return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    const stdout = argv[1] === 'rev-parse' ? '/repo\n' : argv[1] === 'status' ? '' : 'a.js\0'
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.open', async () => ({ value: undefined }) as never)
  await $.command.run({ command: 'tree', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'file:a.js' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\u{e74e}/u })).toBeUndefined()
})

test('rescans every 5s while open, and stops once closed', async ($, on) => {
  const clock = mock.clock(on)
  let listing = 'a.js\0'
  let lsRuns = 0
  const panes: { id: string }[] = []
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  on('process.run', async (_, e) => {
    const argv = (e as { argv?: string[] }).argv ?? (e as unknown as string[][])[0] ?? []
    if (argv.includes('--ignored')) return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    if (argv[1] === 'ls-files') lsRuns++
    const stdout = argv[1] === 'rev-parse' ? '/repo\n' : argv[1] === 'status' ? '' : listing
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('ui.panes', async () => ({ value: panes }) as never)
  on('ui.open', async (_, e) => {
    panes.push({ id: e.id })
    return { value: undefined } as never
  })
  on('ui.close', async () => {
    panes.length = 0
    return { value: undefined } as never
  })

  await $.command.run({ command: 'tree', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'file:new.js' })).toBeUndefined()

  listing = 'a.js\0new.js\0'
  await clock.advance(5000)
  expect(await ui.find({ key: 'file:new.js' })).toBeDefined()

  await $.command.run({ command: 'tree', args: '' } as never)
  const before = lsRuns
  await clock.advance(20000)
  expect(lsRuns).toBe(before)
})

for (const mode of ['dim', 'hide'] as const) {
  test(`ignored: ${mode}`, { options: { ignored: mode } }, async ($, on) => {
    on('session.cwd', async () => ({ value: '/repo' }) as never)
    on('process.run', async (_, e) => {
      const argv = (e as { argv?: string[] }).argv ?? (e as unknown as string[][])[0] ?? []
      const stdout =
        argv[1] === 'rev-parse' ? '/repo\n'
        : argv[1] === 'status' ? ''
        : argv.includes('--ignored') ? '.DS_Store\0node_modules/\0debug.log\0'
        : 'a.js\0'
      return { value: { exitCode: 0, stdout, stderr: '' } } as never
    })
    on('ui.panes', async () => ({ value: [] }) as never)
    on('ui.open', async () => ({ value: undefined }) as never)
    await $.command.run({ command: 'tree', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'desktop', ...PANE })
    expect(await ui.find({ key: 'file:a.js' })).toBeDefined()
    expect(await ui.find({ key: 'file:.DS_Store' })).toBeUndefined()
    if (mode === 'dim') {
      expect((await ui.find({ key: 'file:debug.log' }))?.props).toMatchObject({ dimColor: true })
      expect((await ui.find({ type: 'Text', text: /node_modules\// }))?.props).toMatchObject({ dimColor: true })
      expect(await ui.find({ key: 'dir:node_modules' })).toBeUndefined()
    } else {
      expect(await ui.find({ key: 'file:debug.log' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /node_modules/ })).toBeUndefined()
    }
  })
}

test('clicking a file opens it in VS Code, falling back to open -a; deleted files are skipped', async ($, on) => {
  const runs: string[][] = []
  let hasCodeCli = true
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  on('process.run', async (_, e) => {
    const argv = (e as { argv?: string[] }).argv ?? (e as unknown as string[][])[0] ?? []
    if (argv[0] === 'code' || argv[0] === 'open') runs.push([...argv])
    const exitCode = argv[0] === 'code' && !hasCodeCli ? 127 : 0
    const stdout =
      argv[1] === 'rev-parse' ? '/repo\n'
      : argv[1] === 'status' ? ' D gone.js\0'
      : argv.includes('--ignored') ? ''
      : argv[1] === 'ls-files' ? 'app.js\0gone.js\0'
      : ''
    return { value: { exitCode, stdout, stderr: '' } } as never
  })
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  await $.command.run({ command: 'tree', args: '' } as never)
  const tree = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })

  await tree.press({ key: 'file:app.js' })
  expect(runs).toEqual([['code', '-g', '/repo/app.js']])

  hasCodeCli = false
  await tree.press({ key: 'file:app.js' })
  expect(runs.slice(1)).toEqual([['code', '-g', '/repo/app.js'], ['open', '-a', 'Visual Studio Code', '/repo/app.js']])

  const before = runs.length
  await tree.press({ key: 'file:gone.js' })
  expect(runs.length).toBe(before)
})

test('the filter shows only changed files, from the button or /tree changed', async ($, on) => {
  const panes: { id: string }[] = []
  on('session.cwd', async () => ({ value: '/repo' }) as never)
  on('process.run', async (_, e) => {
    const argv = (e as { argv?: string[] }).argv ?? (e as unknown as string[][])[0] ?? []
    const stdout =
      argv[1] === 'rev-parse' ? '/repo\n'
      : argv[1] === 'status' ? ' M src/lib/b.ts\0'
      : argv.includes('--ignored') ? 'debug.log\0'
      : 'src/a.ts\0src/lib/b.ts\0top.md\0'
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('ui.panes', async () => ({ value: panes }) as never)
  on('ui.open', async (_, e) => {
    panes.push({ id: e.id })
    return { value: undefined } as never
  })

  await $.command.run({ command: 'tree', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'file:top.md' })).toBeDefined()

  await ui.press({ key: 'filter' })
  expect(await ui.find({ key: 'file:top.md' })).toBeUndefined()
  expect(await ui.find({ key: 'file:debug.log' })).toBeUndefined()
  expect(await ui.find({ key: 'file:src/lib/b.ts' })).toBeDefined()
  await ui.press({ key: 'dir:src/lib' })
  expect(await ui.find({ key: 'file:src/lib/b.ts' })).toBeUndefined()

  await $.command.run({ command: 'tree', args: 'changed' } as never)
  expect(await ui.find({ key: 'file:top.md' })).toBeDefined()
  expect(await ui.find({ key: 'file:src/lib/b.ts' })).toBeUndefined()
})
