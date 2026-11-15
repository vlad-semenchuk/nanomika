# Changelog

All notable changes to NanoMika are documented in this file.

## [Unreleased] - standalone core

Rebuild of the project as a small, standalone core that you clone, run and extend with your own channel. History before this point is in git; tag `v2.0.70` marks the last version before the rebuild.

- [BREAKING] **No installer.** `setup/`, `setup.sh`, the `/add-*` and other Claude Code skills, the launchd/systemd service files and the migration scripts are gone. A fresh clone runs with `pnpm install` and `pnpm start`.
- [BREAKING] **No vendored SQLite binary.** `better-sqlite3` now installs normally on every platform instead of from a macOS arm64 prebuilt.
- [BREAKING] **Runtime data is not migrated.** Start with an empty `data/` and `groups/` after pulling this version.
