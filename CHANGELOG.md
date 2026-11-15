# Changelog

All notable changes to NanoMika are documented in this file.

## [3.0.0] - standalone core

Rebuild of the project as a small, standalone core that you clone, run and extend with your own channel. History before this point is in git; tag `v2.0.70` marks the last version before the rebuild.

### Breaking

- **No installer.** `setup/`, `setup.sh`, the `/add-*` and other Claude Code skills, the launchd/systemd service files and the migration scripts are gone. A fresh clone runs with `pnpm install`, `pnpm run build:image` and `pnpm start`. The host runs in the foreground.
- **Runtime data is not migrated.** Start with an empty `data/` and `groups/` after pulling this version.
- **No vendored SQLite binary.** `better-sqlite3` now installs normally on every platform instead of from a macOS arm64 prebuilt.
- **No agent self-modification tools.** The `install_packages` and `add_mcp_server` MCP tools are removed. Packages and MCP servers are still configurable with `ncl groups config`, and a request from an agent still needs approval.
- **Fewer built-in integrations.** The Gmail and Calendar MCP servers are removed from the agent image. The only agent provider is `claude`.
- **Logs go to the terminal.** The service files that redirected output to `logs/` are gone, so nothing writes log files.

### Added

- **First-start bootstrap.** When the database has no agents, the host creates the first agent, the `cli:local` owner and the wiring between them.
- **Startup checks.** The host stops with a message that names the fix when `.env` has no credential, Docker is not running, the agent image is not built, or the checkout path is too long for a Unix socket.
- **Questions and approvals in the terminal.** The CLI channel prints them with numbered options; answer with `pnpm run chat /answer <id> <choice>`.
- **Terminal backlog.** Messages that arrive while no chat is open are kept and shown by the next `pnpm run chat`.
- **`pnpm run build:image`** builds the agent image.
- **[docs/writing-a-channel.md](docs/writing-a-channel.md)**, a guide to adding a channel with a complete example.

### Changed

- The local terminal channel is the only channel enabled by default. The Slack adapter stays in the tree; enable it by uncommenting one import (see the README).
- `.env` values may be followed by a `# comment`.
- `minimumReleaseAge` in `pnpm-workspace.yaml` is now at the top level, where pnpm reads it.
- `agent-browser` in the agent image is pinned to an exact version.
- CI runs lint.
- The documentation is rewritten to match the code.
