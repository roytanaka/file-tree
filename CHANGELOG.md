# Changelog

## 0.2.0 - 2026-10-06

### Added

- A changed-files-only view: the filter row at the top of the pane, or `/tree changed`, narrows the tree to files with a git mark or edited this turn. Folders in that view start open and fold separately from the full tree.

### Changed

- Scanning is split into a Snapshot produced by a git adapter or an fs-walk adapter (internal; no change in behaviour).

## 0.1.0 - 2026-10-06

### Added

- Docked, collapsible file tree of the repo, toggled with `/tree`, that respects `.gitignore` and highlights files edited this turn.
- Git status marks on files and folders, Nerd Font icons (`icons` option), and dimmed or hidden ignored files (`ignored` option).
- Clicking a file opens it in VS Code; the tree rescans every 5 seconds while open.
