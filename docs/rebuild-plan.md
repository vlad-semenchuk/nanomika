# Rebuild plan: nanomika as a standalone core

Status: plan only. Nothing in this document has been implemented.
This file is a working document. Delete it in the final phase, before the merge to `main`.

## 1. Goal

Turn this repo into a small, standalone project that anyone can clone, run and extend with their own channel.

- One Node host process, per-session Docker agent containers, two SQLite files per session, an admin CLI (`ncl`).
- The only channel wired by default is the local CLI.
- No installer, no setup scripts, no `/add-*` skills, no service manager files.
- Host code stays at or under 14,000 non-test lines (hard ceiling 15,000).
- The Anthropic key never enters a container (built-in credential proxy).

## 2. Base decision

The rebuild starts from the current `main` of this repo. It does not start from the newer upstream reference tree.

| | This repo, `main` (5e3c3ed) | Newer upstream reference |
|---|---|---|
| Host code, non-test lines | 13,831 in 126 files | about 41,000 in 258 files |
| After all agreed cuts | about 13,600 | about 26,000 to 28,000 |
| Credential proxy | already built in | replaced by a gateway layer woven through core files |
| Container start/stop code | 499 lines | 1,678 lines plus a 2,500-line driver layer |
| Baseline health | typecheck clean, 337 tests pass | not measured |

The newer tree cannot reach the size target by deleting files. Its gateway, driver and multi-host locking code is imported by the container runner, delivery, router and database layer, so getting to 15k would mean rewriting those files.

Consequences of this choice:

- These newer internals are **not** brought over: the mailbox layer, the reconcile files, the driver layer, the multi-database layer, host leases, and the `ncl tasks` command set.
- A short list of newer features can be ported later, one at a time (section 9).
- The upstream reference tree is read-only. Never modify it, never add it as a git remote here, and never copy its git history. In this plan it is called `$UPSTREAM_REF`; its local path is given to the implementer in the session prompt and is not written into this repo.

## 3. Rules for every phase

1. Work only on branch `rebuild/core`, created from `main`. Do not push to `main` until phase 7.
2. No file content, branch name, commit message or PR text may contain the upstream project's name. Phase 7 has the check command.
3. Never commit `.env`, `data/`, `logs/`, `store/` or `groups/*` content. This repo is public.
4. `LICENSE` stays byte-for-byte unchanged.
5. Every phase ends with the standard checks green (section 5). A phase that cannot get green is reverted, not patched forward.
6. One commit per task card, with a message that says what was removed or added.

## 4. Baseline (measured on `main`, Node 22.18, pnpm 10.33)

- `pnpm run typecheck`: clean.
- `pnpm test`: 33 files, 337 tests, all pass.
- Tracked files: 409.
- Host non-test lines by area:

| Area | Lines | Files | Fate |
|---|---|---|---|
| `src/*.ts` (root) | 4,458 | 28 | keep, minus `backfill-container-configs.ts` (78) and small trims |
| `src/cli/` | 2,099 | 25 | keep |
| `src/db/` | 2,088 | 23 | keep |
| `src/modules/permissions/` | 1,578 | 11 | keep |
| `src/channels/` | 1,339 | 7 | keep (Slack file stays, import off) |
| `src/modules/agent-to-agent/` | 607 | 5 | keep |
| `src/modules/mount-security/` | 389 | 1 | keep |
| `src/modules/scheduling/` | 354 | 4 | keep |
| `src/modules/approvals/` | 332 | 3 | keep |
| `src/modules/self-mod/` | 247 | 3 | **cut** |
| `src/modules/typing/` | 165 | 1 | keep |
| `src/providers/` | 92 | 3 | keep (the provider seam) |
| `src/modules/interactive/` | 59 | 1 | keep |
| `src/modules/index.ts` | 24 | 1 | keep, edit |

Largest kept files: `chat-sdk-bridge.ts` 680, `permissions/index.ts` 632, `session-manager.ts` 543, `container-runner.ts` 499, `router.ts` 496, `delivery.ts` 430.

Size check command (run from the repo root):

```
git ls-files src | grep '\.ts$' | grep -v '\.test\.ts$' | xargs wc -l | tail -1
```

## 5. Standard checks

Run all four after every task card:

```
pnpm run typecheck
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun install --frozen-lockfile && bun test)
```

Record the test file and test counts in the commit message when they change, with the reason (for example "6 setup test files deleted").

## 6. Keep and cut list

### 6.1 Cut whole (no kept code depends on these, except where noted)

| Path | Size | Note |
|---|---|---|
| `setup/` | 87 files | `container/build.sh` sources `setup/lib/install-slug.sh`: inline that first (task 1.1) |
| `setup.sh`, `nanomika.sh`, `migrate-v2.sh`, `migrate-v2-reset.sh` | 4 files | |
| `.claude/skills/` | 21 files | keep `.claude/settings.json` |
| `launchd/`, `repo-tokens/`, `assets/` | 10 files | |
| `vendor/` and `scripts/vendor-better-sqlite3.mjs` | 3 files | the vendored binary is macOS arm64 only, so today a fresh clone fails on Linux and Intel Macs (task 1.3) |
| `scripts/` except `chat.ts`, `q.ts`, `q.test.ts` | 12 files | `init-cli-agent.ts` is the source for the new bootstrap (task 3.1); delete it after that |
| `tsconfig.setup.json`, `vitest.skills.config.ts` | 2 files | |
| `README_ja.md`, `README_zh.md`, `RELEASING.md`, `CONTRIBUTORS.md` | 4 files | |
| `.github/workflows/bump-version.yml`, `label-pr.yml`, `update-tokens.yml`, `.github/CODEOWNERS` | 4 files | keep `ci.yml` |
| `src/modules/self-mod/` | 247 lines | plus `container/agent-runner/src/mcp-tools/self-mod.ts`, `self-mod.instructions.md`, and `container/skills/self-customize/` |
| `src/backfill-container-configs.ts` | 78 lines | fresh install only |
| Docs: `corp-install.md`, `trusted-package-manifest.md`, `superpowers/`, `setup-flow.md`, `setup-wiring.md`, `skills-as-branches.md`, `migration-dev.md`, `v1-to-v2-changes.md`, `BRANCH-FORK-MAINTENANCE.md`, `APPLE-CONTAINER-NETWORKING.md`, `docker-sandboxes.md`, `ollama.md` | 13 files | |

### 6.2 Keep, with edits

| Path | Edit |
|---|---|
| `src/index.ts` | remove backfill and the one-time `migrateGroupsToClaudeLocal` call; call the new bootstrap and image check |
| `src/claude-md-compose.ts` | remove `migrateGroupsToClaudeLocal` if nothing else uses it |
| `src/install-slug.ts` | keep the slug and image-name helpers; remove the launchd and systemd helpers |
| `src/cli/transport-errors.ts` (+ test) | replace the launchctl/systemctl hint with "start the host: `pnpm start`" |
| `src/config.ts` | remove exports with no remaining users (candidates: `ASSISTANT_HAS_OWN_NUMBER`, `SENDER_ALLOWLIST_PATH`, `STORE_DIR`, `TRIGGER_PATTERN`); verify each with grep before deleting |
| `src/channels/index.ts` | `./cli.js` only; the Slack line becomes a commented one-line opt-in |
| `src/modules/index.ts` | remove the self-mod import and the skill-install comments |
| `src/webhook-server.ts` | keep: `chat-sdk-bridge.ts` imports it for webhook-mode adapters |
| `container/agent-runner/src/mcp-tools/index.ts` | remove the self-mod import |
| `container/build.sh` | inline the image-name logic; no reference to `setup/` |
| `container/Dockerfile` | remove the Gmail and Calendar MCP servers and their two `ARG` lines; keep the digest-pinned base image |
| `package.json` | scripts: drop `setup`, `setup:auto`, `auth`, `postinstall`; `build` becomes `tsc`; add `build:image`. Dependencies: drop `@clack/core`, `@clack/prompts`, `kleur` if no kept file imports them |
| `pnpm-workspace.yaml` | add `better-sqlite3` to `onlyBuiltDependencies` so it installs on every platform |
| `vitest.config.ts` | include `src/**` and `scripts/**` only |
| `.github/workflows/ci.yml` | Node 22 (matches `engines`) |
| `.env.example`, `.gitignore` | rewrite for the new first-run flow; remove dead entries |
| `CHANGELOG.md` | reset to a single entry for the rebuild |
| `README.md`, `CLAUDE.md`, `CONTRIBUTING.md` | rewrite (phase 5) |
| Docs kept: `architecture.md`, `architecture-diagram.md`, `db.md`, `db-central.md`, `db-session.md`, `isolation-model.md`, `agent-runner-details.md`, `build-and-runtime.md`, `api-details.md`, `SECURITY.md`, `SDK_DEEP_DIVE.md`, `README.md` | accuracy pass in phase 5 |
| Docs to review, then keep or cut: `SPEC.md`, `REQUIREMENTS.md` | cut if they describe setup, skills or the old origin |
| `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md` | check whether `group-init.ts` or the composer reads them; keep only if used, and scrub setup/skill references |
| `container/skills/` | keep `agent-browser`, `welcome`, `slack-formatting`; scrub references to setup or self-modification |

### 6.3 Keep unchanged

Everything else under `src/`, `container/agent-runner/`, `bin/ncl`, `config-examples/`, `eslint.config.js`, `.husky/`, `.prettierrc`, `.nvmrc`, `.npmrc`, `LICENSE`, and every test of kept code.

### 6.4 Expected result

- Host non-test lines: about 13,600 (13,831 − 247 − 78 − about 60 of trims + about 150 of new bootstrap code).
- Tracked files: about 240, down from 409.

## 7. Phases

Dependency order: 0 → 1 → (2, 4 and 5a in parallel) → 3 → 5b → 6 → 7.
Phases 1 and 3 both edit `package.json` and `src/index.ts`, so they never run in parallel with each other.

### Phase 0: preparation

Entry: clean clone of this repo on `main` at 5e3c3ed.

- 0.1 Create branch `rebuild/core`.
- 0.2 Run the standard checks and confirm they match section 4.
- 0.3 Commit this plan file.

Exit: branch exists locally, baseline confirmed. Nothing pushed yet.

### Phase 1: delete what nothing depends on

Entry: phase 0 done.

- 1.1 Inline the image-name logic into `container/build.sh` so it no longer sources `setup/lib/install-slug.sh`. It must produce the same name as `getContainerImageBase()` in `src/install-slug.ts` (`nanomika-agent-v2-<sha1(project root)[:8]>`). Verify by printing both.
- 1.2 Delete every path in section 6.1 except the self-mod and backfill rows (those are phase 2) and `scripts/init-cli-agent.ts` (phase 3).
- 1.3 Fix the build config: `package.json` scripts and dependencies, `pnpm-workspace.yaml`, `vitest.config.ts`, `ci.yml`, per section 6.2. Regenerate `pnpm-lock.yaml` with `pnpm install`. Confirm `better-sqlite3` loads without the vendored file (`node -e "require('better-sqlite3')(':memory:')"`).
- 1.4 Reset `CHANGELOG.md`.

Exit: standard checks green; `git ls-files setup .claude/skills vendor launchd repo-tokens assets` prints nothing; no kept file references a deleted path (`git grep -nE "setup/|vendor/|launchd|/add-" -- src container bin package.json` shows only comments queued for phase 2).

### Phase 2: trim host code

Entry: phase 1 done. Can run in parallel with phases 4 and 5a.

- 2.1 Remove self-modification: host module, container MCP tool and its instructions file, the `self-customize` skill, and the two import lines. Keep `buildAgentGroupImage` because `ncl groups` still calls it. Update `approvals/project.md` and comments that name self-mod as a client.
- 2.2 Remove `backfill-container-configs.ts` and the one-time CLAUDE.md migration function, with their calls in `src/index.ts` and any tests.
- 2.3 Trim `install-slug.ts`, `transport-errors.ts` and `config.ts` per section 6.2.
- 2.4 Turn the Slack import in `src/channels/index.ts` into a commented opt-in line. `src/channels/slack.ts` and the `@chat-adapter/slack` dependency stay, so Socket Mode keeps working once the line is enabled and `SLACK_BOT_TOKEN` plus `SLACK_APP_TOKEN` are set.
- 2.5 Comment sweep in `src/` and `container/`: remove mentions of `/add-*` skills, the `channels`/`providers`/`modules` branches, OneCLI, setup scripts and service managers. Comments only; no behavior change.

Exit: standard checks green; size check at or under 13,700; `git grep -niE "onecli|self-mod|/add-|launchctl|systemctl" -- src container` prints nothing.

### Phase 3: clone-and-run first start

Entry: phases 1 and 2 done.

Target experience:

```
git clone … && cd nanomika
pnpm install
cp .env.example .env        # add ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
pnpm run build:image        # local docker build, no registry pull of the agent image
pnpm start                  # or pnpm dev
pnpm run chat hello         # in a second terminal
```

- 3.1 Add `src/bootstrap.ts` (about 100 lines), built from `scripts/init-cli-agent.ts`. On start, when the central DB has zero agent groups, it creates: the `cli:local` user with the owner role, one agent group (name from `ASSISTANT_NAME`), its group folder, the `cli/local` messaging group and the wiring between them. It must be idempotent and do nothing when any agent group exists. Add a test. Then delete `scripts/init-cli-agent.ts`.
- 3.2 Add an image check at startup: if the agent image is missing, stop with one clear message that names `pnpm run build:image`. Do not build automatically. Add `build:image` to `package.json` (runs `container/build.sh`).
- 3.3 Fail fast with a clear message when neither `ANTHROPIC_API_KEY` nor `CLAUDE_CODE_OAUTH_TOKEN` is set, instead of failing on the first agent call.
- 3.4 Rewrite `.env.example` with only the variables the kept code reads, grouped as required / optional / Slack.
- 3.5 Update the error text in `scripts/chat.ts` to point at `pnpm start`.

Exit: standard checks green, and the fresh-clone smoke test passes: clone the branch into an empty temporary directory, follow the five commands above with a real key, and get an agent reply in the terminal. Also confirm with `docker inspect` that the running container's environment holds only the placeholder key, not the real one.

### Phase 4: container image

Entry: phase 1 done. Can run in parallel with phase 2.

- 4.1 Remove the Gmail and Calendar MCP installs and their `ARG` lines from `container/Dockerfile`. Remove `zod-to-json-schema` only if nothing else needs it (it was installed in the same step).
- 4.2 Build the image locally and run the container test suite.

Exit: `pnpm run build:image` succeeds from a clean Docker cache; `bun test` green.

### Phase 5: documentation

5a can start after phase 1. 5b needs phase 3.

- 5a Delete the cut docs (already in 1.2) and fix every link that pointed at them.
- 5b.1 Rewrite `README.md`: what it is, the five-command quick start, the architecture in one diagram, how to add a channel, how to enable Slack, where the docs are.
- 5b.2 Rewrite `CLAUDE.md`: remove the "hard fork" header, the setup/skills/migration/OneCLI rows and any file that no longer exists. Every path in the key-files table must exist.
- 5b.3 Write `docs/writing-a-channel.md`, using `src/channels/cli.ts` as the worked example of a native adapter (`src/channels/adapter.ts` interface, registration in `channel-registry.ts`, the one import line in `channels/index.ts`), and `src/channels/slack.ts` as the example of a Chat SDK adapter through `chat-sdk-bridge.ts`.
- 5b.4 Accuracy pass over the kept docs: remove sections about setup, skills-as-branches, other runtimes and removed modules. Decide `SPEC.md` and `REQUIREMENTS.md`.
- 5b.5 Rewrite `CONTRIBUTING.md` to match (short).

Exit: no doc links to a missing file (check every relative link); every path named in `README.md` and `CLAUDE.md` exists; a reader can add a toy channel by following `docs/writing-a-channel.md` alone.

### Phase 6: final audit

Entry: phases 1 to 5 done.

- 6.1 Name check. Both must print nothing:
  ```
  git grep -il "<upstream project name>"
  git log main..HEAD --format=%B | grep -i "<upstream project name>"
  ```
  Also review `git grep -ilE "upstream|fork"` by hand and reword what describes the old origin.
- 6.2 Secret check: `git ls-files | grep -E '^(\.env|data/|logs/|store/)'` prints only `.env.example`; scan the diff for key-shaped strings.
- 6.3 Size check at or under 14,000.
- 6.4 Dead-code check: `pnpm run lint`, and confirm no unused exports were left by the trims.
- 6.5 Repeat the fresh-clone smoke test from phase 3 on the final commit.
- 6.6 Set the version in `package.json` (proposed `3.0.0`) and finish the `CHANGELOG.md` entry.
- 6.7 Delete this plan file.

Exit: all six checks pass on one commit.

### Phase 7: merge

Entry: phase 6 passed and the owner has approved.

- 7.1 Tag current `main` as `v2.0.70` and push the tag. This is the rollback point.
- 7.2 Push `rebuild/core` and open a PR to `main`. CI must pass.
- 7.3 Merge. Delete the branch.

Exit: `main` passes CI and the fresh-clone smoke test.

## 8. Risks

| # | Risk | Likelihood | Handling |
|---|---|---|---|
| 1 | The fresh-clone path was never exercised: today the setup scripts create the agent, the wiring and the image. Something they did silently may be missing. | High | Phase 3 exit is a real fresh-clone run, not a unit test. Read `setup/index.ts`, `setup/container.ts` and `setup/register.ts` in phase 0 (before deleting) and list every side effect; map each to bootstrap, README step, or "not needed". |
| 2 | Removing the vendored SQLite binary breaks install where native builds are blocked. | Medium | Task 1.3 verifies a normal install loads the module. Locked-down hosts are out of scope (open decision 1). |
| 3 | `cli:local` as owner changes who can approve actions. | Medium | The CLI socket is local to the machine, so local user as owner is reasonable. Confirm approvals reach the CLI channel during the phase 3 smoke test (open decision 4). |
| 4 | Removing self-modification leaves the approvals module with fewer clients, or leaves agent-facing instructions that mention tools that no longer exist. | Medium | Task 2.1 greps container instruction files and skills. `cli/dispatch.ts` and permissions still use approvals, so the module stays. |
| 5 | Kept docs describe behavior that was removed. | High | Phase 5b.4 is an accuracy pass with path checks, reviewed by the orchestrator, not delegated blind. |
| 6 | Linux differences: the credential proxy bind address and `host.docker.internal`. | Medium | Logic already exists in `container-runtime.ts`. If a Linux host is available, run the smoke test there; otherwise state in the README that Linux is untested. |
| 7 | Old origin text survives in a comment or doc. | Medium | Phase 6.1, including a manual review of "upstream" and "fork" hits (39 files mention one of them today, most of them in paths that get deleted). |
| 8 | A parallel task edits the same file as another. | Low | The parallel lanes in section 10 touch disjoint paths; `package.json` and `src/index.ts` are only edited in phases 1 and 3. |
| 9 | A secret is pushed to the public repo. | Low, high impact | `.gitignore` already covers `.env*`, `data/`, `logs/`; phase 6.2 re-checks; nothing is pushed before phase 7. |

## 9. Later: features that can be ported from the newer reference

Not part of this rebuild. Each is a separate change after the merge, copied as files with no git history, with any origin-revealing names reworded.

| Feature | Size in the reference | Coupling | Recommendation |
|---|---|---|---|
| Agent memory scaffold (`container/agent-runner/src/memory/`) | about 140 lines of code plus 3 templates and 5 small tests | imports only `fs`/`path`; needs a hook in `providers/claude.ts` | first candidate |
| Shared slash-command parser (`src/slash-command.ts` plus a generated runner copy) | 54 lines | standalone | second candidate |
| Channel defaults and card rendering helpers | about 500 lines | touches the bridge | only if a channel needs it |
| `ncl tasks`, mailbox layer, reconcile files, driver layer | 3,000+ lines | depends on each other and on the new database layer | do not port |

## 10. Notes for the implementation session (orchestrator plus subagents)

- The orchestrator owns sequencing, runs the standard checks after each task card, and reviews every diff before commit. Subagents get one task card each.
- Give each subagent: the task card text, the relevant rows of section 6, the rules in section 3, and the standard check commands. Do not give them this whole file.
- Mechanical cards, safe to delegate fully: 1.1, 1.2, 1.4, 2.2, 2.3, 2.4, 2.5, 3.4, 3.5, 4.1, 5a, 5b.5.
- Cards that need orchestrator design or review before commit: 1.3 (dependency removal), 2.1 (cross-cutting removal), 3.1 to 3.3 (new code), 5b.1 to 5b.4 (accuracy), all of phase 6.
- Parallel lanes after phase 1: lane A = phase 2 (`src/`), lane B = phase 4 (`container/Dockerfile`), lane C = phase 5a (`docs/`). Task 2.1 also edits two files under `container/agent-runner/src/mcp-tools/` and `container/skills/`; lane B must not touch those.
- Subagents must not run `git push`, must not touch `$UPSTREAM_REF`, and must not read or print `.env`.
- The fresh-clone smoke test needs a real key and a running Docker. Run it in the orchestrator session, not in a subagent.

## 11. Rollback

- Until phase 7, `main` is untouched. Dropping the branch undoes everything.
- Inside the branch, each task card is one commit; revert the commit of a failed card.
- After the merge, tag `v2.0.70` is the last pre-rebuild state: `git revert` the merge commit, or reset `main` to the tag if the owner prefers.
- Runtime data is not migrated. A user of the old version who pulls the new `main` should start with an empty `data/` and `groups/` (state this in the changelog).

## 12. Decisions (all confirmed by the owner on 2026-11-15)

| # | Decision | Confirmed choice |
|---|---|---|
| 1 | Corporate trusted-install hardening (vendored SQLite binary, trusted-package manifest, corp install docs, setup dispatcher) | Dropped. The vendored binary must go either way because it only works on macOS arm64. |
| 2 | Gmail and Calendar MCP servers in the agent image | Dropped. The digest-pinned base image stays. |
| 3 | Slack | Adapter file and dependency kept; import commented out so only the CLI is wired. Alternative: leave the import on, since the adapter is inert without `SLACK_BOT_TOKEN`. |
| 4 | Owner on first start | `cli:local` gets the owner role. |
| 5 | Version after the rebuild | `3.0.0`. |
| 6 | Agent self-modification (agents installing packages / MCP servers with approval) | Cut, as agreed. |
