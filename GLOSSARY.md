# Glossary

**Snapshot**: one scan's view of the repo: its root, the files listed, the ignored paths, a git mark per changed path, and an error string. Mirrors the plugin's stored state minus the view state: `expanded`, `edited`, `changedOnly` and `folded`.

**Scan**: produces a Snapshot, through the git adapter (`git ls-files` / `git status`) when the cwd is in a repo, otherwise through the fs-walk adapter, which honours every `.gitignore` it meets.
