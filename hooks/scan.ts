// Scan: one look at the repo, as a Snapshot. git ls-files when in a repo (exact
// .gitignore semantics); otherwise walk the tree ourselves, honouring every
// .gitignore we meet.

import type { GitMark, RelPath } from '../types'
import { collapseIgnored, isHidden, isIgnored, parseGitignore, parseStatus } from './tree'
import type { Rule } from './tree'

const MAX_FILES = 20000
const SKIP = new Set(['.git', 'node_modules'])

export type Snapshot = {
  root: string
  files: RelPath[]
  /** Ignored paths; a folder ends in `/` and is not descended. */
  ignored: RelPath[]
  status: Record<RelPath, GitMark>
  error: string
}

// What a scan needs from the outside world. Any of them may throw.
export type Ports = {
  cwd: string
  run: (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  list: (abs: string) => Promise<{ name: string; kind: 'file' | 'dir' | 'other' }[]>
  read: (abs: string) => Promise<string>
}

export type ScanOptions = { includeIgnored: boolean }

export async function scan(ports: Ports, opts: ScanOptions): Promise<Snapshot> {
  const top = await ports.run(['git', 'rev-parse', '--show-toplevel'], ports.cwd).catch(() => undefined)
  if (top && top.exitCode === 0) return fromGit(ports, top.stdout.trim(), opts)
  return fromWalk(ports, opts)
}

async function fromGit({ run }: Ports, dir: string, { includeIgnored }: ScanOptions): Promise<Snapshot> {
  const ls = await run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], dir)
  const files = [...new Set(ls.stdout.split('\0').filter(p => p !== '' && !isHidden(p)))].slice(0, MAX_FILES)
  let ignored: string[] = []
  if (includeIgnored) {
    const ig = await run(['git', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], dir)
    if (ig.exitCode === 0) ignored = collapseIgnored(ig.stdout.split('\0').filter(Boolean)).slice(0, MAX_FILES)
  }
  const st = await run(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], dir)
  const status = st.exitCode === 0 ? parseStatus(st.stdout) : {}
  const error = ls.exitCode === 0 ? '' : ls.stderr.trim()
  return { root: dir, files, ignored, status, error }
}

async function fromWalk({ cwd, list, read }: Ports, { includeIgnored }: ScanOptions): Promise<Snapshot> {
  const files: string[] = []
  const ignored: string[] = []
  const walk = async (rel: string, rules: Rule[]) => {
    if (files.length >= MAX_FILES) return
    const abs = rel ? `${cwd}/${rel}` : cwd
    const entries = await list(abs).catch(() => [])
    if (entries.some(en => en.name === '.gitignore' && en.kind === 'file')) {
      const text = await read(`${abs}/.gitignore`).catch(() => '')
      rules = [...rules, ...parseGitignore(text, rel)]
    }
    for (const en of entries) {
      if (SKIP.has(en.name) || en.name === '.DS_Store') continue
      const path = rel ? `${rel}/${en.name}` : en.name
      const isDir = en.kind === 'dir'
      if (isIgnored(rules, path, isDir)) {
        if (includeIgnored && ignored.length < MAX_FILES) ignored.push(isDir ? `${path}/` : path)
        continue
      }
      if (isDir) await walk(path, rules)
      else if (files.length < MAX_FILES) files.push(path)
    }
  }
  await walk('', [])
  return { root: cwd, files, ignored, status: {}, error: '' }
}
