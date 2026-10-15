# Changelog

## 0.1.0

First public release.

- Types out Claude Code's `Edit`, `Write` and `MultiEdit` changes letter by letter:
  red highlight, strike-through and backspace, human-rhythm typing, green highlight.
- New files are typed out from empty, at full reading pace: long edits are not sped up
  unless `liveEdits.speedUpLongEdits` is on.
- Status bar shows the edit being typed; click to skip to its end.
- Saving a file mid-animation restores its real contents on disk.
- Closes files it opened and returns to the Claude chat after the last edit.
- One-click setup of Claude Code `http` hooks, with a backup of `~/.claude/settings.json`;
  hooks are removed on uninstall.
- Works across several editor windows; the window holding the session's folder shows the edit.
- Settings for speeds, pauses and the optional speed-up; status bar pause/resume.
