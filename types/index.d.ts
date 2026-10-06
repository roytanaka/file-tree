/** A path relative to the tree's root, `/`-separated. */
export type RelPath = string

/** Git status: Modified, Added, Deleted, Renamed, Untracked, Conflicted. */
export type GitMark = 'M' | 'A' | 'D' | 'R' | 'U' | 'C'

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      root: string
      files: RelPath[]
      expanded: RelPath[]
      edited: RelPath[]
      error: string
      status: Record<RelPath, GitMark>
      /** Ignored paths shown dimmed; a folder ends in `/` and is not descended. */
      ignored: RelPath[]
      /** Show only files with a git mark or edited this turn. */
      changedOnly: boolean
      /** Folders collapsed in the changed-only view, where folders start open. */
      folded: RelPath[]
    }
  }
}
