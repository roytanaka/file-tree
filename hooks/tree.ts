// Pure helpers: .gitignore matching (fallback when not in a git repo) and tree flattening.

import type { GitMark } from '../types'

export type Rule = { re: RegExp; negate: boolean; dirOnly: boolean }

export function parseGitignore(text: string, base = ''): Rule[] {
  const rules: Rule[] = []
  for (let line of text.split('\n')) {
    line = line.replace(/\r$/, '')
    if (!line.trim() || line.startsWith('#')) continue
    line = line.replace(/(?<!\\)\s+$/, '')
    let negate = false
    if (line.startsWith('!')) { negate = true; line = line.slice(1) }
    let dirOnly = false
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1) }
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    let src = ''
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (c === '*') {
        if (line[i + 1] === '*') {
          if (line[i + 2] === '/') { src += '(?:.*/)?'; i += 2 } else { src += '.*'; i++ }
        } else src += '[^/]*'
      } else if (c === '?') src += '[^/]'
      else if (c === '\\' && i + 1 < line.length) src += line[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      else src += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    const prefix = base ? base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' : ''
    const re = anchored ? new RegExp(`^${prefix}${src}$`) : new RegExp(`^${prefix}(?:.*/)?${src}$`)
    rules.push({ re, negate, dirOnly })
  }
  return rules
}

export function isIgnored(rules: readonly Rule[], path: string, isDir: boolean): boolean {
  let ignored = false
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue
    if (r.re.test(path)) ignored = !r.negate
  }
  return ignored
}

export type Row = { path: string; name: string; depth: number; isDir: boolean; isOpen: boolean }

type Node = { dirs: Map<string, Node>; files: string[] }

export function flatten(files: readonly string[], expanded: ReadonlySet<string>): Row[] {
  const root: Node = { dirs: new Map(), files: [] }
  for (const f of files) {
    // A path ending in `/` is a folder with nothing listed in it.
    const parts = f.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part)
      if (!next) node.dirs.set(part, (next = { dirs: new Map(), files: [] }))
      node = next
    }
    const name = parts[parts.length - 1]!
    if (name !== '') node.files.push(name)
  }
  const rows: Row[] = []
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
      const path = prefix + name
      const isOpen = expanded.has(path)
      rows.push({ path, name, depth, isDir: true, isOpen })
      if (isOpen) walk(node.dirs.get(name)!, path + '/', depth + 1)
    }
    for (const name of [...node.files].sort((a, b) => a.localeCompare(b))) {
      rows.push({ path: prefix + name, name, depth, isDir: false, isOpen: false })
    }
  }
  walk(root, '', 0)
  return rows
}

export function ancestors(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

export function relativeTo(root: string, path: string): string | undefined {
  if (!path.startsWith('/')) return path.replace(/^\.\//, '')
  const r = root.endsWith('/') ? root : root + '/'
  return path.startsWith(r) ? path.slice(r.length) : undefined
}

// Strongest first: a folder takes the mark of its strongest descendant.
export const MARK_ORDER: readonly GitMark[] = ['C', 'M', 'D', 'R', 'A', 'U']

export function parseStatus(porcelainZ: string): Record<string, GitMark> {
  const out: Record<string, GitMark> = {}
  const parts = porcelainZ.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    const x = entry[0]!, y = entry[1]!
    const path = entry.slice(3)
    if (x === 'R' || x === 'C') i++ // the next field is the original path
    const xy = x + y
    let mark: GitMark | undefined
    if (xy === '??') mark = 'U'
    else if (x === 'U' || y === 'U' || xy === 'DD' || xy === 'AA') mark = 'C'
    else {
      const code = y !== ' ' ? y : x
      mark = code === 'D' ? 'D' : code === 'A' ? 'A' : code === 'R' ? 'R' : code === 'C' ? 'A' : 'M'
    }
    out[path] = mark
  }
  return out
}

export function folderMarks(status: Readonly<Record<string, GitMark>>): Record<string, GitMark> {
  const out: Record<string, GitMark> = {}
  for (const [path, mark] of Object.entries(status)) {
    for (const dir of ancestors(path)) {
      const cur = out[dir]
      if (cur === undefined || MARK_ORDER.indexOf(mark) < MARK_ORDER.indexOf(cur)) out[dir] = mark
    }
  }
  return out
}

export const isHidden = (path: string) => path === '.DS_Store' || path.endsWith('/.DS_Store')

// git lists an ignored folder as `dir/`, and sometimes files under it too; keep the folder alone.
export function collapseIgnored(paths: readonly string[]): string[] {
  const dirs = paths.filter(p => p.endsWith('/'))
  return paths.filter(p => !isHidden(p) && !dirs.some(d => p !== d && p.startsWith(d)))
}

// The changed-only view: files with a git mark or edited this turn, plus the
// folders that hold them (all open unless folded).
export function changedView(
  files: readonly string[],
  status: Readonly<Record<string, GitMark>>,
  edited: readonly string[],
  folded: ReadonlySet<string>,
): { files: string[]; open: Set<string> } {
  const changed = new Set([...Object.keys(status), ...edited])
  const kept = files.filter(f => changed.has(f))
  const open = new Set(kept.flatMap(ancestors).filter(d => !folded.has(d)))
  return { files: kept, open }
}
