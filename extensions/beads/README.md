# Beads for Muxy

A Muxy extension that shows Beads issues from the active workspace as either a pinned panel or a full workspace tab.

```bash
npm install
npm run build
```

Load `extensions/beads/` with Muxy's **Load Unpacked** flow. After rebuilding, click **Reload** in the Extensions modal.

## Behavior

- Reads `bd list --json --all --limit 0`.
- Uses `bd ready --json` only to add a `Ready` badge.
- Falls back to `issues.jsonl` or `.beads/issues.jsonl`.
- Shows built-in Beads statuses plus discovered custom statuses.
- Offers three saved views: a Kanban Board, a dense Dependency Ledger, and a prioritized Ready Path.
- Opens as a full workspace tab from **Beads: Open Workspace Tab** in the command palette.
- Lets columns collapse and reorder locally without changing Beads data.
- Persists the selected view, column order, and auto-update interval.

## Permissions

- `commands:exec` to run `bd`.
- `files:read` for JSONL fallback.
- `projects:read` and `worktrees:read` for active workspace context.
- `panels:write` for the panel and topbar toggle.
- `tabs:write` for opening the full Beads workspace tab.
- `storage:read` and `storage:write` for saved view, column order, and refresh preferences.
