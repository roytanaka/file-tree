import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, Timer, UiPane } from 'claude-code'

import type { GitMark } from '../types'
import { FOLDER_CLOSED, FOLDER_OPEN, fileIcon } from './icons'
import { scan } from './scan'
import type { Ports, ScanOptions, Snapshot } from './scan'
import { ancestors, flatten, folderMarks, relativeTo } from './tree'

const PANE = 'file-tree'
// The viewer tab of an earlier version; closed if a session still has it open.
const OLD_VIEWER = 'file-view'
const MAX_ROWS = 3000
const POLL_MS = 5000

const root = atom({ plugin: 'file-tree', key: 'root' } as const, '')
const files = atom({ plugin: 'file-tree', key: 'files' } as const, [])
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [])
const edited = atom({ plugin: 'file-tree', key: 'edited' } as const, [])
const error = atom({ plugin: 'file-tree', key: 'error' } as const, '')
const status = atom({ plugin: 'file-tree', key: 'status' } as const, {})
const ignored = atom({ plugin: 'file-tree', key: 'ignored' } as const, [])

const MARK_COLOR: Record<GitMark, string> = {
  M: 'warning', A: 'success', U: 'success', D: 'error', R: 'suggestion', C: 'merged',
}

// Idle rescans write nothing, so the pane only redraws when something changed.
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function commit($: Engine, snap: Snapshot) {
  if (!same(await read($, ignored), snap.ignored)) await update($, ignored, () => snap.ignored)
  if (!same(await read($, status), snap.status)) await update($, status, () => snap.status)
  if (!same(await read($, root), snap.root)) await update($, root, () => snap.root)
  if (!same(await read($, files), snap.files)) await update($, files, () => snap.files)
  if (!same(await read($, error), snap.error)) await update($, error, () => snap.error)
}

async function portsFrom($: Engine): Promise<Ports> {
  return {
    cwd: await $.session.cwd(),
    run: (argv, cwd) => $.process.run(argv, { cwd }),
    list: abs => $.fs.list(abs),
    read: async abs => {
      const text = await $.fs.read(abs)
      return typeof text === 'string' ? text : ''
    },
  }
}

async function rescan($: Engine, opts: ScanOptions) {
  await commit($, await scan(await portsFrom($), opts))
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

function startPolling($: Engine, opts: ScanOptions) {
  ticker ??= $.clock.every(POLL_MS, () => {
    if (isScanning) return
    isScanning = true
    void rescan($, opts).catch(() => {}).finally(() => { isScanning = false })
  })
}

function stopPolling() {
  ticker?.cancel()
  ticker = undefined
}

export const register: Register = (on, options) => {
  // Nerd Font glyphs need the terminal's own font; other surfaces draw without them.
  const wantsIcons = options.icons !== 'none'
  const scanOpts: ScanOptions = { includeIgnored: options.ignored !== 'hide' }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tree',
      description: 'Toggle the file tree pane (respects .gitignore, highlights files edited this turn)',
    })
    if (await isPaneOpen($, OLD_VIEWER)) await $.ui.close({ id: OLD_VIEWER })
    if (await isOpen($)) startPolling($, scanOpts)
    return next(e)
  })

  on('command.run', { command: 'tree' }, async $ => {
    if (await isOpen($)) {
      await $.ui.close({ id: PANE })
      return { text: 'File tree closed.' }
    }
    await rescan($, scanOpts)
    await $.ui.open({ id: PANE, title: 'Files' })
    startPolling($, scanOpts)
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
    if (await isOpen($)) await rescan($, scanOpts).catch(() => {})
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
        if (await isOpen($)) await rescan($, scanOpts)
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
