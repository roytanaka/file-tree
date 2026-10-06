import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, FsEntry, Register, Timer, UiPane } from 'claude-code'

import { FOLDER_CLOSED, FOLDER_OPEN, fileIcon } from './icons'
import { ancestors, collapseIgnored, flatten, isHidden, folderMarks, isIgnored, parseGitignore, parseStatus, relativeTo } from './tree'
import type { GitMark, Rule } from './tree'

const PANE = 'file-tree'
// The viewer tab of an earlier version; closed if a session still has it open.
const OLD_VIEWER = 'file-view'
const MAX_FILES = 20000
const MAX_ROWS = 3000
const POLL_MS = 5000
const SKIP = new Set(['.git', 'node_modules'])

const root = atom({ plugin: 'file-tree', key: 'root' } as const, '')
const files = atom({ plugin: 'file-tree', key: 'files' } as const, [])
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [])
const edited = atom({ plugin: 'file-tree', key: 'edited' } as const, [])
const error = atom({ plugin: 'file-tree', key: 'error' } as const, '')
const status = atom({ plugin: 'file-tree', key: 'status' } as const, {})
const ignored = atom({ plugin: 'file-tree', key: 'ignored' } as const, [])

// The `ignored` setting, read once per load of the module.
let showIgnored = true

const MARK_COLOR: Record<GitMark, string> = {
  M: 'warning', A: 'success', U: 'success', D: 'error', R: 'suggestion', C: 'merged',
}

// Idle rescans write nothing, so the pane only redraws when something changed.
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

// git ls-files when in a repo (exact .gitignore semantics); otherwise walk the
// tree ourselves, honouring every .gitignore we meet.
async function scan($: Engine) {
  const cwd = await $.session.cwd()
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => undefined)
  if (top && top.exitCode === 0) {
    const dir = top.stdout.trim()
    const ls = await $.process.run(
      ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: dir },
    )
    const list = [...new Set(ls.stdout.split('\0').filter(p => p !== '' && !isHidden(p)))].slice(0, MAX_FILES)
    let skipped: string[] = []
    if (showIgnored) {
      const ig = await $.process.run(
        ['git', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
        { cwd: dir },
      )
      if (ig.exitCode === 0) skipped = collapseIgnored(ig.stdout.split('\0').filter(Boolean)).slice(0, MAX_FILES)
    }
    if (!same(await read($, ignored), skipped)) await update($, ignored, () => skipped)
    const st = await $.process.run(
      ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: dir },
    )
    const marks = st.exitCode === 0 ? parseStatus(st.stdout) : {}
    if (!same(await read($, status), marks)) await update($, status, () => marks)
    if (!same(await read($, root), dir)) await update($, root, () => dir)
    if (!same(await read($, files), list)) await update($, files, () => list)
    const problem = ls.exitCode === 0 ? '' : ls.stderr.trim()
    if ((await read($, error)) !== problem) await update($, error, () => problem)
    return
  }

  const list: string[] = []
  const skipped: string[] = []
  const walk = async (rel: string, rules: Rule[]) => {
    if (list.length >= MAX_FILES) return
    const abs = rel ? `${cwd}/${rel}` : cwd
    const entries: FsEntry[] = await $.fs.list(abs).catch(() => [])
    if (entries.some(en => en.name === '.gitignore' && en.kind === 'file')) {
      const text = await $.fs.read(`${abs}/.gitignore`).catch(() => '')
      rules = [...rules, ...parseGitignore(typeof text === 'string' ? text : '', rel)]
    }
    for (const en of entries) {
      if (SKIP.has(en.name) || en.name === '.DS_Store') continue
      const path = rel ? `${rel}/${en.name}` : en.name
      const isDir = en.kind === 'dir'
      if (isIgnored(rules, path, isDir)) {
        if (showIgnored && skipped.length < MAX_FILES) skipped.push(isDir ? `${path}/` : path)
        continue
      }
      if (isDir) await walk(path, rules)
      else if (list.length < MAX_FILES) list.push(path)
    }
  }
  await walk('', [])
  if (!same(await read($, ignored), skipped)) await update($, ignored, () => skipped)
  if (!same(await read($, status), {})) await update($, status, () => ({}))
  if (!same(await read($, root), cwd)) await update($, root, () => cwd)
  if (!same(await read($, files), list)) await update($, files, () => list)
  if (!same(await read($, error), '')) await update($, error, () => '')
}

async function isPaneOpen($: Engine, id: string) {
  return (await $.ui.panes()).some((p: UiPane) => p.id === id)
}

async function isOpen($: Engine) {
  return isPaneOpen($, PANE)
}

// Opens the file in VS Code (`code -g` reuses the open window); falls back to
// macOS `open -a` when the `code` command isn't on the PATH the mod sees.
async function openInEditor($: Engine, abs: string) {
  const viaCli = await $.process.run(['code', '-g', abs], { timeoutMs: 10_000 }).catch(() => undefined)
  if (viaCli?.exitCode === 0) return
  const viaApp = await $.process.run(['open', '-a', 'Visual Studio Code', abs], { timeoutMs: 10_000 })
    .catch(() => undefined)
  if (viaApp?.exitCode !== 0) {
    $.ui.toast(`file-tree: could not open VS Code: ${(viaApp?.stderr || viaCli?.stderr || 'not found').trim()}`)
  }
}

// Rescans while the pane is open, so changes made outside the session show up.
// Module state: a reload starts over, and session.start re-arms it.
let ticker: Timer | undefined
let isScanning = false

function startPolling($: Engine) {
  ticker ??= $.clock.every(POLL_MS, () => {
    if (isScanning) return
    isScanning = true
    void scan($).catch(() => {}).finally(() => { isScanning = false })
  })
}

function stopPolling() {
  ticker?.cancel()
  ticker = undefined
}

export const register: Register = (on, options) => {
  // Nerd Font glyphs need the terminal's own font; other surfaces draw without them.
  const wantsIcons = options.icons !== 'none'
  showIgnored = options.ignored !== 'hide'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tree',
      description: 'Toggle the file tree pane (respects .gitignore, highlights files edited this turn)',
    })
    if (await isPaneOpen($, OLD_VIEWER)) await $.ui.close({ id: OLD_VIEWER })
    if (await isOpen($)) startPolling($)
    return next(e)
  })

  on('command.run', { command: 'tree' }, async $ => {
    if (await isOpen($)) {
      await $.ui.close({ id: PANE })
      return { text: 'File tree closed.' }
    }
    await scan($)
    await $.ui.open({ id: PANE, title: 'Files' })
    startPolling($)
    return { text: 'File tree opened.' }
  })

  // The person may close it with its close mark or ctrl+x x rather than /tree.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopPolling()
    return next(e)
  }).catch(($, e, next) => next(e))

  // A file click opens it in VS Code; deleted files have nothing to open.
  on('ui.press', { requestId: PANE }, async ($, e, next) => {
    if (!e.element.startsWith('file:')) return next(e)
    const rel = e.element.slice('file:'.length)
    if ((await read($, status))[rel] === 'D') {
      $.ui.toast(`file-tree: ${rel} is deleted`)
      return { element: e.element }
    }
    const dir = (await read($, root)) || (await $.session.cwd())
    await openInEditor($, `${dir}/${rel}`)
    return { element: e.element }
  })

  on('turn.start', async ($, e, next) => {
    await update($, edited, () => [])
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (await isOpen($)) await scan($).catch(() => {})
    return done
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const target =
      e.tool === 'Edit' || e.tool === 'Write' ? e.file_path
      : e.tool === 'NotebookEdit' ? e.notebook_path
      : undefined
    if (target === undefined || ran.deny !== undefined || ran.isError === true) return ran

    try {
      const dir = (await read($, root)) || (await $.session.cwd())
      const rel = relativeTo(dir, target)
      if (rel !== undefined) {
        await update($, edited, list => (list.includes(rel) ? list : [...list, rel]))
        await update($, expanded, list => [...new Set([...list, ...ancestors(rel)])])
        if (await isOpen($)) await scan($)
      }
    } catch {
      // Bookkeeping only; never let it affect the tool's result.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const hasIcons = wantsIcons && e.surface === 'terminal'
    const [list, open, touched, problem, marks, skipped] = await Promise.all([
      read($, files), read($, expanded), read($, edited), read($, error), read($, status),
      read($, ignored),
    ])
    const skippedSet = new Set(skipped)
    const dirMarks = folderMarks(marks)
    const touchedSet = new Set(touched)
    const hot = new Set(touched.flatMap(ancestors))
    const rows = flatten([...list, ...skipped], new Set(open))
    const shown = rows.slice(0, MAX_ROWS)

    const toggle = (path: string) => () =>
      void update($, expanded, cur => (cur.includes(path) ? cur.filter(p => p !== path) : [...cur, path]))

    return (
      <Box flexDirection="column">
        {problem !== '' && <Text color="red" wrap="truncate">{problem}</Text>}
        {list.length === 0 && <Text dimColor>No files.</Text>}
        {shown.map(row => {
          const indent = '  '.repeat(row.depth)
          if (row.isDir && skippedSet.has(`${row.path}/`)) {
            // An ignored folder: one dim row, never opened.
            return (
              <Text key={`row:${row.path}`} dimColor wrap="truncate">
                {`${indent}  ${hasIcons ? `${FOLDER_CLOSED.glyph} ` : ''}${row.name}/`}
              </Text>
            )
          }
          if (row.isDir) {
            // Button labels can't take a colour, so the chevron and icon sit beside it.
            const mark = dirMarks[row.path]
            const folder = row.isOpen ? FOLDER_OPEN : FOLDER_CLOSED
            return (
              <Box key={`row:${row.path}`}>
                <Text dimColor>{`${indent}${row.isOpen ? '▾' : '▸'} `}</Text>
                {hasIcons && <Text color={folder.color}>{`${folder.glyph} `}</Text>}
                <Button plain key={`dir:${row.path}`} onPress={toggle(row.path)}>
                  {`${row.name}/`}
                </Button>
                {hot.has(row.path) && <Text color="claude"> ●</Text>}
                {mark !== undefined && <Text color={MARK_COLOR[mark]}> •</Text>}
              </Box>
            )
          }
          // File names are Buttons (a click opens VS Code via the ui.press hook), which
          // can't take a colour: status shows in the icon, the letter and the edit dot.
          const isEdited = touchedSet.has(row.path)
          const mark = marks[row.path]
          const icon = fileIcon(row.name)
          const isSkipped = skippedSet.has(row.path)
          return (
            <Box key={`row:${row.path}`}>
              <Text>{`${indent}  `}</Text>
              {hasIcons && (
                <Text color={isSkipped ? undefined : icon.color} dimColor={isSkipped}>
                  {`${icon.glyph} `}
                </Text>
              )}
              <Button
                plain
                key={`file:${row.path}`}
                dimColor={isSkipped && !isEdited}
                onPress={() => {}}
              >
                {row.name}
              </Button>
              {isEdited && <Text color="claude" bold> ●</Text>}
              {mark !== undefined && <Text color={MARK_COLOR[mark]}>{` ${mark}`}</Text>}
            </Box>
          )
        })}
        {rows.length > shown.length && <Text dimColor>… {rows.length - shown.length} more rows</Text>}
        {touched.length > 0 && (
          <Text dimColor>{`${touched.length} file${touched.length === 1 ? '' : 's'} edited this turn`}</Text>
        )}
      </Box>
    )
  })

}
