# Contributing

## What is welcome

- Bug fixes, security fixes, simplifications, doc fixes and tests.
- Features that belong in core. The host has a size budget: non-test TypeScript in `src/` stays at or under 14,000 lines. A feature PR must say how many lines it adds and why it belongs in core.
- New channels, as a single adapter file under `src/channels/`, following [docs/writing-a-channel.md](docs/writing-a-channel.md). Leave it out of the default import list in `src/channels/index.ts` unless it needs no credentials.

## Dev setup

Requires Node 24, pnpm 10, Docker, and Bun (for the agent-runner tests).

```
pnpm install
pnpm run build:image
cp .env.example .env    # set one credential
pnpm dev
pnpm run chat hello     # in a second terminal
```

## Checks before a PR

```
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun install --frozen-lockfile && bun test)
```

## Two runtimes

- The host is Node + pnpm + vitest.
- `container/agent-runner/` is Bun + `bun:test`, with its own `bun.lock`. It is not a pnpm workspace. Tests there import from `bun:test`.

## Dependencies

pnpm enforces a 3-day minimum release age (`minimumReleaseAge` in `pnpm-workspace.yaml`). Do not add a `minimumReleaseAgeExclude` entry, and do not add to `onlyBuiltDependencies`, unless a maintainer agrees in the PR.

## Secrets and runtime data

Never commit `.env`, or anything under `data/`, `logs/` or `groups/`. Never put a real key in a test or doc.

## Commits and PRs

- One logical change per PR.
- The description says what changed and how you tested it.

## License

Contributions are released under the repository's [MIT License](LICENSE).
