# Corp-Laptop Trusted-Install Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a NanoMika tree that installs and runs on a locked-down corporate laptop pulling only pinned, prebuilt, pure-JS-or-npm-prebuilt packages from the default npm registry — no install-time arbitrary code execution, no GitHub-branch fetches, fully auditable — while keeping Slack (two-way), Gmail (tool), and Google Calendar (tool).

**Architecture:** Remove OneCLI entirely (runtime already done; this finishes the setup flow). Pin the host to Node 22 and make `better-sqlite3` install with zero compilation by vendoring its prebuilt `.node` and copying it into place via our own auditable root postinstall. Ship a built `dist/` + `pnpm install --prod --frozen-lockfile`. Slim the tree to Slack + Gmail + Calendar, rewiring the Google tools from OneCLI-managed stubs to native Google OAuth (real creds in a mounted dir). Build the container image here and `docker save`/`load` onto corp (Colima). Finish with an auditable package manifest.

**Tech Stack:** Node 22 LTS (host, pnpm 10.33.0), Bun (container agent-runner), `better-sqlite3@11.10.0`, `@chat-adapter/slack@4.27.0` (Chat SDK bridge), `@gongrzhe/server-gmail-autoauth-mcp@1.1.11`, `@cocal/google-calendar-mcp@2.6.1`, Docker/Colima, the in-tree credential proxy (`src/credential-proxy.ts`).

**Source spec:** `docs/superpowers/specs/2026-06-07-corp-trusted-install-hardening-design.md`

**Commit convention for this plan:** All commits are authored by Vlad only. **Do NOT add a `Co-Authored-By: Claude` trailer** to any commit in this plan (overrides the default harness convention — the design requires Vlad-only authorship). Commit frequently per the steps below.

---

## File Structure

Files created or modified across the plan, grouped by responsibility:

**Phase 0 — runtime OneCLI removal (already done, uncommitted):**
- `src/credential-proxy.ts`, `src/credential-proxy.test.ts` (new) — host-side Anthropic credential proxy.
- `src/index.ts`, `src/container-runner.ts`, `src/config.ts`, `src/modules/approvals/index.ts`, `src/modules/approvals/response-handler.ts`, `setup/verify.ts`, `package.json`, `pnpm-lock.yaml` (modified).
- `src/modules/approvals/onecli-approvals.ts` (deleted).

**Phase 1 — setup-flow OneCLI removal:**
- `setup/onecli.ts` (delete) — OneCLI installer/health step.
- `setup/auto.ts` (modify) — drop the `onecli` step block, rewire auth call sites to write `.env`, delete `detectExistingOnecli` + `anthropicSecretExists` OneCLI probe.
- `setup/auth.ts` (rewrite) — verify/write the Anthropic credential in `.env` instead of the OneCLI vault.
- `setup/index.ts` (modify) — remove the `onecli` step registration.
- `setup/lib/setup-config.ts` (modify) — remove `onecliApiHost` / `onecliApiToken` config entries.
- `setup/lib/claude-assist.ts` (modify) — remove the `onecli` file map entry.
- `setup/environment.test.ts` (modify) — drop `ONECLI_URL` from the credential regex.
- `.claude/skills/init-onecli/` (delete) — the OneCLI install skill.
- `container/skills/onecli-gateway/` (delete) — the in-container OneCLI gateway skill.

**Phase 2 — trusted runtime pin:**
- `package.json` (modify) — `engines.node` → `22.x`, add `postinstall`.
- `pnpm-workspace.yaml` (modify) — drop `better-sqlite3`, `protobufjs`, `sharp` from `onlyBuiltDependencies`.
- `scripts/vendor-better-sqlite3.mjs` (new) — auditable postinstall that copies the vendored binary into the pnpm store.
- `vendor/better-sqlite3/better_sqlite3.node` (new) — the pinned prebuilt binary.
- `vendor/better-sqlite3/PROVENANCE.md` (new) — sha256 + how the binary was produced.

**Phase 3 — slim to Slack + Gmail + Calendar:**
- `src/channels/slack.ts` (new, vendored from `channels` branch), `src/channels/index.ts` (modify), `package.json` (add `@chat-adapter/slack`).
- `.claude/skills/add-gmail-tool/SKILL.md`, `.claude/skills/add-gcal-tool/SKILL.md` (rewrite — native Google OAuth).
- ~30 `.claude/skills/add-*` and misc skill dirs (delete), 3 `container/skills/` dirs (delete).
- `container/Dockerfile` (modify — slim global installs).

**Phase 4 — container image packaging:**
- `container/Dockerfile` (modify — pin base by digest, add Gmail/Calendar MCP installs).
- `docs/corp-install.md` (new) — `docker save`/`load` + Colima wiring runbook.

**Phase 5 — auditable manifest:**
- `scripts/gen-trusted-manifest.mjs` (new) — emits the pinned package list.
- `docs/trusted-package-manifest.md` (new, generated artifact).
- `tsconfig.setup.json` (new — emit `dist/setup/` so corp runs setup without `tsx`).

---

## Phase 0 — Land the runtime OneCLI removal

The credential-proxy change is already implemented and verified (typecheck/build/target tests green on Node 22), sitting uncommitted on `main`. Commit it to a branch.

### Task 0.1: Branch and commit the credential-proxy change

**Files:** all currently-modified `src/` + `setup/verify.ts` + `package.json` + `pnpm-lock.yaml` (see `git status`).

- [ ] **Step 1: Confirm the working tree matches the expected change set**

Run:
```bash
git status --short
```
Expected (order may vary):
```
 M package.json
 M pnpm-lock.yaml
 M setup/verify.ts
 M src/config.ts
 M src/container-runner.ts
A  src/credential-proxy.test.ts
A  src/credential-proxy.ts
 M src/index.ts
 M src/modules/approvals/index.ts
 D src/modules/approvals/onecli-approvals.ts
 M src/modules/approvals/response-handler.ts
?? docs/superpowers/
```

- [ ] **Step 2: Verify typecheck, build, and tests on Node 22**

Run:
```bash
node --version          # expect v22.x
pnpm run typecheck && pnpm run build && pnpm test
```
Expected: typecheck clean, build emits `dist/`, test suite green. If any fail, STOP and debug before committing.

- [ ] **Step 3: Create the work branch**

Run:
```bash
git switch -c corp-trusted-install
```
Expected: `Switched to a new branch 'corp-trusted-install'`.

- [ ] **Step 4: Stage and commit the runtime change (Vlad-only author, NO Claude trailer)**

Run:
```bash
git add package.json pnpm-lock.yaml setup/verify.ts \
  src/config.ts src/container-runner.ts src/credential-proxy.ts \
  src/credential-proxy.test.ts src/index.ts \
  src/modules/approvals/index.ts src/modules/approvals/onecli-approvals.ts \
  src/modules/approvals/response-handler.ts
git commit -m "Replace OneCLI runtime with built-in Anthropic credential proxy"
```
Do not include a `Co-Authored-By` line. Verify:
```bash
git log -1 --format='%an <%ae>%n%B'
```
Expected: author is Vlad; body has no `Co-Authored-By`.

- [ ] **Step 5: Commit the design + this plan separately**

Run:
```bash
git add docs/superpowers/
git commit -m "Add corp trusted-install hardening design + implementation plan"
```

- [ ] **Step 6: Push the branch**

Run:
```bash
git push -u origin corp-trusted-install
```
Expected: branch pushed; print the branch URL.

---

## Phase 1 — Finish OneCLI removal (setup flow)

After this phase, `/setup` must run end-to-end with no OneCLI step, and the Anthropic credential lands in `.env` (which `src/credential-proxy.ts` reads via `readEnvFile`).

### Task 1.1: Rewrite `setup/auth.ts` to use `.env` instead of the OneCLI vault

**Files:**
- Rewrite: `setup/auth.ts`

The proxy reads `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` from `.env` (`src/credential-proxy.ts:31-39`). This step must check/write those keys, not OneCLI secrets.

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `setup/auth.ts` with:

```typescript
/**
 * Step: auth — Verify or register an Anthropic credential in .env.
 *
 * Modes:
 *   --check                   (default) Verify an Anthropic credential exists in .env.
 *   --create --value <token>  Write an Anthropic credential to .env. Errors if one
 *                             already exists unless --force is passed.
 *
 * The credential proxy (src/credential-proxy.ts) reads ANTHROPIC_API_KEY /
 * CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN from .env and injects them into
 * outbound requests. The token value is never logged.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const CRED_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

interface Args {
  mode: 'check' | 'create';
  value?: string;
  force: boolean;
}

function parseArgs(args: string[]): Args {
  let mode: 'check' | 'create' = 'check';
  let value: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    switch (key) {
      case '--check':
        mode = 'check';
        break;
      case '--create':
        mode = 'create';
        break;
      case '--value':
        value = val;
        i++;
        break;
      case '--force':
        force = true;
        break;
    }
  }

  if (mode === 'create' && !value) {
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'missing_value_for_create',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  return { mode, value, force };
}

function envPath(): string {
  return path.join(process.cwd(), '.env');
}

function readEnv(): string {
  const p = envPath();
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

/** Returns the credential key already present in .env, or null. */
function findCredentialKey(content: string): string | null {
  for (const key of CRED_KEYS) {
    if (new RegExp(`^${key}=.+$`, 'm').test(content)) return key;
  }
  return null;
}

/** Pick the .env key for a pasted token by shape. */
function keyForValue(value: string): string {
  return value.startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
}

function writeCredential(key: string, value: string): void {
  // `value` is a credential — never log it.
  const content = readEnv();
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : content.trimEnd() + (content ? '\n' : '') + `${key}=${value}\n`;
  fs.writeFileSync(envPath(), next);
}

export async function run(args: string[]): Promise<void> {
  const { mode, value, force } = parseArgs(args);
  const content = readEnv();
  const existingKey = findCredentialKey(content);

  if (mode === 'check') {
    emitStatus('AUTH', {
      SECRET_PRESENT: !!existingKey,
      ANTHROPIC_OK: !!existingKey,
      STATUS: existingKey ? 'success' : 'missing',
      ...(existingKey ? { SECRET_NAME: existingKey } : {}),
      LOG: 'logs/setup.log',
    });
    return;
  }

  // mode === 'create'
  if (existingKey && !force) {
    emitStatus('AUTH', {
      SECRET_PRESENT: true,
      STATUS: 'skipped',
      REASON: 'anthropic_credential_already_exists',
      SECRET_NAME: existingKey,
      HINT: 'Re-run with --force to replace, or remove the existing .env line first.',
      LOG: 'logs/setup.log',
    });
    return;
  }

  const key = existingKey ?? keyForValue(value!);
  try {
    writeCredential(key, value!);
  } catch (err) {
    log.error('writing credential to .env failed', { err });
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'env_write_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const updatedKey = findCredentialKey(readEnv());
  emitStatus('AUTH', {
    SECRET_PRESENT: !!updatedKey,
    ANTHROPIC_OK: !!updatedKey,
    CREATED: true,
    STATUS: updatedKey ? 'success' : 'failed',
    ...(updatedKey ? { SECRET_NAME: updatedKey } : {}),
    LOG: 'logs/setup.log',
  });
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm exec tsc --noEmit
```
Expected: no errors. (Confirms no dangling OneCLI imports in `auth.ts`.)

- [ ] **Step 3: Commit**

```bash
git add setup/auth.ts
git commit -m "setup/auth: write Anthropic credential to .env, drop OneCLI vault calls"
```

### Task 1.2: Rewire `setup/auto.ts` auth call sites and delete the OneCLI step

**Files:**
- Modify: `setup/auto.ts`

This file has three OneCLI surfaces: the `onecli` step block (~178-278), the auth write call sites (`runPasteAuth` ~834-863, `runCustomEndpointAuth` ~888-919), and the `detectExistingOnecli` + `anthropicSecretExists` probes (~1176, ~1192-1225). All read/write must move to `.env` via the existing `writeEnvLine` helper (`setup/auto.ts:933`).

- [ ] **Step 1: Remove the import of `pollHealth`**

Delete this line (around line 52):
```typescript
import { pollHealth } from './onecli.js';
```

- [ ] **Step 2: Delete the entire `onecli` step block**

Delete the whole `if (!skip.has('onecli')) { … }` block (approximately lines 178-278 — from the `if (!skip.has('onecli'))` line through its closing `}`). This removes both the remote-mode and local-install branches.

- [ ] **Step 3: Rewire `runPasteAuth` to write `.env`**

In `runPasteAuth` (around lines 834-863), replace the `runQuietChild('auth', 'onecli', [...], …)` call and its `if (!res.ok)` block with a direct `.env` write:

Replace:
```typescript
  const res = await runQuietChild(
    'auth',
    'onecli',
    [
      'secrets', 'create', '--name', 'Anthropic', '--type', 'anthropic',
      '--value', token, '--host-pattern', 'api.anthropic.com',
    ],
    {
      running: `Saving your ${label} to your OneCLI vault…`,
      done: 'Claude account connected.',
    },
    { extraFields: { METHOD: method } },
  );
  if (!res.ok) {
    await fail(
      'auth',
      `Couldn't save your ${label} to the vault.`,
      'Make sure OneCLI is running (`onecli version`), then retry.',
    );
  }
```
With:
```typescript
  const envKey = method === 'oauth' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  try {
    writeEnvLine(envKey, token);
  } catch {
    await fail(
      'auth',
      `Couldn't save your ${label} to .env.`,
      'Check that the project directory is writable, then retry.',
    );
  }
  setupLog.step('auth', 'interactive', 0, { METHOD: method });
  p.log.success(brandBody('Claude account connected.'));
```

- [ ] **Step 4: Rewire `runCustomEndpointAuth` to write `.env`**

In `runCustomEndpointAuth` (around lines 888-924), replace the `runQuietChild('auth', 'onecli', [...generic secret...])` call + its `if (!res.ok)` block with writing the token to `.env` as `ANTHROPIC_AUTH_TOKEN` (the proxy reads this for custom endpoints — `src/credential-proxy.ts:33`). Keep the existing `writeEnvLine('ANTHROPIC_BASE_URL', baseUrl)` and `appendProviderImport('./claude.js')` calls.

Replace the `runQuietChild(...)` + `if (!res.ok) { … }` block with:
```typescript
  try {
    writeEnvLine('ANTHROPIC_AUTH_TOKEN', token);
  } catch {
    await fail(
      'auth',
      `Couldn't save your Anthropic auth token to .env.`,
      'Check that the project directory is writable, then retry.',
    );
  }
```
Leave the lines below it intact:
```typescript
  writeEnvLine('ANTHROPIC_BASE_URL', baseUrl);
  appendProviderImport('./claude.js');
```

- [ ] **Step 5: Replace `anthropicSecretExists` with an `.env` check**

Find `anthropicSecretExists()` (it wraps `spawnSync('onecli', ['secrets', 'list'], …)` around line 1176). Replace its body to read `.env`:
```typescript
function anthropicSecretExists(): boolean {
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return false;
  const content = fs.readFileSync(envFile, 'utf-8');
  return /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN)=.+$/m.test(content);
}
```

- [ ] **Step 6: Delete `detectExistingOnecli`**

Delete the entire `detectExistingOnecli()` function (approximately lines 1188-1225, including its doc comment). It is only called from inside the now-deleted `onecli` step block.

- [ ] **Step 7: Clean residual OneCLI comments**

Remove or reword the OneCLI-specific comments at the lines the explore pass flagged: the step-list comment (~line 16, drop `onecli|` from the `(environment|container|onecli|auth|mounts|…)` enumeration), the "Installers we run mid-setup (OneCLI, claude)…" comment (~68-71 — reword to drop OneCLI, keep the PATH-patch rationale for `claude`), and the stray comment fragments at ~715, ~868-870, ~923. These are non-functional; just keep the file honest.

- [ ] **Step 8: Typecheck**

Run:
```bash
pnpm exec tsc --noEmit
```
Expected: no errors. If it reports `runQuietChild`/`pollHealth`/`detectExistingOnecli` unused, remove their now-orphaned imports/helpers too (only if unused elsewhere — grep first).

- [ ] **Step 9: Grep for residual functional OneCLI references in auto.ts**

Run:
```bash
grep -niE "onecli" setup/auto.ts
```
Expected: zero hits (or only an incidental word in unrelated prose — there should be none after Step 7).

- [ ] **Step 10: Commit**

```bash
git add setup/auto.ts
git commit -m "setup/auto: drop OneCLI step, write credentials to .env"
```

### Task 1.3: Remove the `onecli` step registration and delete `setup/onecli.ts`

**Files:**
- Modify: `setup/index.ts:24`
- Delete: `setup/onecli.ts`

- [ ] **Step 1: Remove the step registration**

In `setup/index.ts`, delete the line (around line 24):
```typescript
  onecli: () => import('./onecli.js'),
```

- [ ] **Step 2: Delete the file**

```bash
git rm setup/onecli.ts
```

- [ ] **Step 3: Typecheck**

```bash
pnpm exec tsc --noEmit
```
Expected: no errors (no remaining importer of `./onecli.js`).

- [ ] **Step 4: Commit**

```bash
git add setup/index.ts
git commit -m "setup: remove onecli step registration and onecli.ts"
```

### Task 1.4: Remove OneCLI config entries and the file map entry

**Files:**
- Modify: `setup/lib/setup-config.ts` (remove `onecliApiHost` + `onecliApiToken` entries, ~lines 66-87)
- Modify: `setup/lib/claude-assist.ts:54` (remove `onecli: ['setup/onecli.ts'],`)

- [ ] **Step 1: Delete the two config objects**

In `setup/lib/setup-config.ts`, delete both entries — the `{ key: 'onecliApiHost', … }` object and the `{ key: 'onecliApiToken', … }` object (the entire two objects, including their trailing commas). No other entries use `group: 'OneCLI'`, so that group disappears cleanly.

- [ ] **Step 2: Remove the file-map entry**

In `setup/lib/claude-assist.ts`, delete the line (around line 54):
```typescript
  onecli: ['setup/onecli.ts'],
```

- [ ] **Step 3: Typecheck**

```bash
pnpm exec tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add setup/lib/setup-config.ts setup/lib/claude-assist.ts
git commit -m "setup: drop OneCLI config entries and file map"
```

### Task 1.5: Fix the `environment.test.ts` credential regex

**Files:**
- Modify: `setup/environment.test.ts` (lines 87, 94, 101, 108)

`ONECLI_URL` is no longer a credential marker; the proxy only honors the three Anthropic keys.

- [ ] **Step 1: Drop `|ONECLI_URL` from the regex (all four occurrences)**

Use replace-all. Change every occurrence of:
```typescript
/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m
```
to:
```typescript
/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)=/m
```
(This now matches `setup/verify.ts:142`, which already uses the three-key form.)

- [ ] **Step 2: Run the test file**

Run:
```bash
pnpm exec vitest run setup/environment.test.ts
```
Expected: PASS. If a case asserted `ONECLI_URL` alone counts as "configured", that assertion must flip to "not configured" — update the expectation to match (a bare `ONECLI_URL` is no longer a credential).

- [ ] **Step 3: Commit**

```bash
git add setup/environment.test.ts
git commit -m "setup: ONECLI_URL is no longer a credential marker"
```

### Task 1.6: Delete the OneCLI skills

**Files:**
- Delete: `.claude/skills/init-onecli/`
- Delete: `container/skills/onecli-gateway/`

- [ ] **Step 1: Remove both skill directories**

```bash
git rm -r .claude/skills/init-onecli container/skills/onecli-gateway
```

- [ ] **Step 2: Grep the tree for remaining functional OneCLI references**

Run:
```bash
grep -rniE "onecli" src/ setup/ container/ --include='*.ts' | grep -viE "^\\s*//|^\\s*\\*" || echo "no functional refs"
```
Expected: `no functional refs` (only comments, if any, remain). If functional code surfaces, remove it before continuing.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/init-onecli container/skills/onecli-gateway
git commit -m "Remove init-onecli skill and onecli-gateway container skill"
```

### Task 1.7: Verify `/setup` runs without an OneCLI step

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck + build + tests**

Run:
```bash
pnpm exec tsc --noEmit && pnpm run build && pnpm test
```
Expected: all green.

- [ ] **Step 2: Confirm the auth step works against `.env` in isolation**

Run:
```bash
pnpm exec tsx setup/auth.ts --check
```
Expected: an `AUTH` status block with `STATUS: missing` (if `.env` has no Anthropic key) or `STATUS: success` (if it does). No OneCLI invocation, no crash.

- [ ] **Step 3: Confirm the step registry no longer lists `onecli`**

Run:
```bash
grep -n "onecli" setup/index.ts || echo "clean"
```
Expected: `clean`.

---

## Phase 2 — Pin the trusted runtime

Make the host install on Node 22 with zero compilation: vendor the `better-sqlite3` prebuilt and copy it via our own postinstall, and stop pnpm from running the package's GitHub-fetching install script.

### Task 2.1: Pin `engines.node` and confirm `.nvmrc`

**Files:**
- Modify: `package.json` (`engines`)
- Verify: `.nvmrc` (already `22`)

- [ ] **Step 1: Set the engines range**

In `package.json`, change:
```json
  "engines": {
    "node": ">=20"
  },
```
to:
```json
  "engines": {
    "node": "22.x"
  },
```

- [ ] **Step 2: Confirm `.nvmrc`**

Run:
```bash
cat .nvmrc
```
Expected: `22`. (Already present — no edit needed.)

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Pin host to Node 22 (engines)"
```

### Task 2.2: Vendor the `better-sqlite3` prebuilt + provenance

**Files:**
- Create: `vendor/better-sqlite3/better_sqlite3.node`
- Create: `vendor/better-sqlite3/PROVENANCE.md`

Do this on the trusted machine, where a normal `pnpm install` has already produced the prebuilt under the pnpm store (`better-sqlite3` is still in `onlyBuiltDependencies` at this point, so `prebuild-install` fetched the binary).

- [ ] **Step 1: Locate the existing prebuilt**

Run:
```bash
ls -la node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node
```
Expected: the file exists. If missing, run `pnpm install` first (with the current `onlyBuiltDependencies`).

- [ ] **Step 2: Copy it into the vendor dir and record sha256 + ABI**

Run:
```bash
mkdir -p vendor/better-sqlite3
cp node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
   vendor/better-sqlite3/better_sqlite3.node
shasum -a 256 vendor/better-sqlite3/better_sqlite3.node
node -p "process.versions.modules + ' / ' + process.platform + '-' + process.arch"
```
Note the printed sha256 and the ABI string (expected `127 / darwin-arm64` on a Node 22 Apple-silicon machine) for the next step.

- [ ] **Step 3: Write provenance**

Create `vendor/better-sqlite3/PROVENANCE.md` (substitute the actual sha256 from Step 2):
```markdown
# Vendored prebuilt: better-sqlite3

- **Package:** better-sqlite3@11.10.0 (SQLite 3.49.2)
- **File:** better_sqlite3.node
- **Target:** Node ABI 127 (Node 22.x), darwin-arm64
- **sha256:** <PASTE_FROM_shasum>

## How it was produced

Fetched by `better-sqlite3`'s own `prebuild-install` during a normal
`pnpm install` on the trusted build machine (Node 22, darwin-arm64), then
copied verbatim out of the pnpm store:

    node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node

No source compilation occurred — the binary is the upstream npm/GitHub-Releases
prebuilt published for better-sqlite3@11.10.0. On corp this file is copied into
place by `scripts/vendor-better-sqlite3.mjs` (see package.json `postinstall`),
so corp fetches and compiles nothing for SQLite.

## Re-verify integrity

    shasum -a 256 vendor/better-sqlite3/better_sqlite3.node
```

- [ ] **Step 4: Commit**

```bash
git add vendor/better-sqlite3/
git commit -m "Vendor better-sqlite3 prebuilt (.node) with provenance"
```

### Task 2.3: Add the auditable postinstall copy script

**Files:**
- Create: `scripts/vendor-better-sqlite3.mjs`
- Modify: `package.json` (`scripts.postinstall`)

- [ ] **Step 1: Write the copy script**

Create `scripts/vendor-better-sqlite3.mjs`:
```javascript
#!/usr/bin/env node
// Auditable, dependency-free postinstall: copy the vendored better-sqlite3
// prebuilt into the pnpm store so the package loads without compiling or
// fetching anything. Runs after every install (incl. `pnpm install --prod`).
//
// No-ops cleanly when better-sqlite3 isn't installed (e.g. a docs-only checkout).
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'vendor', 'better-sqlite3', 'better_sqlite3.node');
const destDir = join(
  root,
  'node_modules',
  '.pnpm',
  'better-sqlite3@11.10.0',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
);
const dest = join(destDir, 'better_sqlite3.node');

if (!existsSync(src)) {
  console.error(`[vendor-better-sqlite3] missing vendored binary: ${src}`);
  process.exit(1);
}
if (!existsSync(join(root, 'node_modules', '.pnpm', 'better-sqlite3@11.10.0'))) {
  console.log('[vendor-better-sqlite3] better-sqlite3 not installed; skipping');
  process.exit(0);
}
if (existsSync(dest)) {
  console.log('[vendor-better-sqlite3] binary already present; skipping');
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[vendor-better-sqlite3] installed prebuilt -> ${dest}`);
```

- [ ] **Step 2: Register the postinstall hook**

In `package.json` `scripts`, add a `postinstall` entry (place it after `prepare`):
```json
    "postinstall": "node scripts/vendor-better-sqlite3.mjs",
```

- [ ] **Step 3: Commit**

```bash
git add scripts/vendor-better-sqlite3.mjs package.json
git commit -m "Add auditable postinstall to vendor better-sqlite3 prebuilt"
```

### Task 2.4: Stop pnpm from running third-party build scripts

**Files:**
- Modify: `pnpm-workspace.yaml`

`better-sqlite3` must leave `onlyBuiltDependencies` (so pnpm never runs `prebuild-install || node-gyp rebuild` — no GitHub fetch, no compile). `protobufjs` and `sharp` are stale (not in the dependency graph at all). Keep `esbuild` (used by `tsx`/`vitest` in dev) and `minimumReleaseAge`.

- [ ] **Step 1: Edit the workspace file**

Replace `pnpm-workspace.yaml` contents with:
```yaml
onlyBuiltDependencies:
  - esbuild

pnpm:
  minimumReleaseAge: 4320
```

- [ ] **Step 2: Prove a clean install runs no build script and the binary lands**

Run:
```bash
rm -rf node_modules
pnpm install --frozen-lockfile 2>&1 | tee /tmp/pnpm-install.log
grep -i "running.*install script\|node-gyp\|prebuild-install" /tmp/pnpm-install.log || echo "NO BUILD SCRIPTS RAN"
ls -la node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node
```
Expected: `NO BUILD SCRIPTS RAN`, and the `.node` exists (placed by our postinstall). If pnpm warns about ignored build scripts for `better-sqlite3`, that's the goal — it's no longer in the allowlist.

- [ ] **Step 3: Prove the host loads the binary and boots**

Run:
```bash
node -e "const D=require('better-sqlite3'); const db=new D(':memory:'); console.log('sqlite', db.prepare('select sqlite_version() v').get().v); db.close();"
pnpm run build && pnpm test
```
Expected: prints a SQLite version (e.g. `sqlite 3.49.2`), build clean, full test suite green.

- [ ] **Step 4: Prove the prod-only install also works**

Run:
```bash
rm -rf node_modules
pnpm install --prod --frozen-lockfile
node -e "require('better-sqlite3'); console.log('prod load OK')"
```
Expected: `prod load OK`. Then restore dev deps for continued work:
```bash
pnpm install --frozen-lockfile
```

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml
git commit -m "Remove better-sqlite3 (vendored) and stale protobufjs/sharp from onlyBuiltDependencies"
```

---

## Phase 3 — Slim to Slack + Gmail + Calendar

### Task 3.1: Vendor the Slack adapter into the tree

**Files:**
- Create: `src/channels/slack.ts` (from `channels` branch)
- Modify: `src/channels/index.ts`
- Modify: `package.json` (add `@chat-adapter/slack@4.27.0`)

Vendor on the trusted machine so corp never `git fetch`es a branch.

- [ ] **Step 1: Fetch the channels branch and copy the adapter**

```bash
git fetch origin channels
git show origin/channels:src/channels/slack.ts > src/channels/slack.ts
```
Expected: `src/channels/slack.ts` created and non-empty (`wc -l src/channels/slack.ts` > 0).

- [ ] **Step 2: Append the self-registration import**

Add to the end of `src/channels/index.ts`:
```typescript
import './slack.js';
```

- [ ] **Step 3: Install the pinned adapter package**

```bash
pnpm install @chat-adapter/slack@4.27.0
```
Expected: added to `dependencies` in `package.json`, lockfile updated. (Subject to the 3-day `minimumReleaseAge` gate — `4.27.0` is well-aged.)

- [ ] **Step 4: Build**

```bash
pnpm run build
```
Expected: clean. Confirms the adapter and its self-registration import compile.

- [ ] **Step 5: Commit**

```bash
git add src/channels/slack.ts src/channels/index.ts package.json pnpm-lock.yaml
git commit -m "Vendor Slack adapter (@chat-adapter/slack@4.27.0) into the tree"
```

> **Risk to surface to the operator (do not silently skip):** the Chat SDK Slack adapter receives events via an HTTP webhook on port 3000 (`/webhook/slack`), which must be publicly reachable. On a locked-down corp laptop, inbound webhooks may be blocked. If two-way Slack must work without a public ingress, confirm whether `@chat-adapter/slack@4.27.0` supports Slack **Socket Mode** (outbound WebSocket, needs an app-level `xapp-` token) and wire `SLACK_APP_TOKEN` accordingly. Capture the resolved approach in `docs/corp-install.md` (Task 4.2). This is an open item, not blocking for vendoring.

### Task 3.2: Rewrite `add-gmail-tool` for native Google OAuth

**Files:**
- Rewrite: `.claude/skills/add-gmail-tool/SKILL.md`

The OneCLI stub/interception model is gone. The MCP server (`@gongrzhe/server-gmail-autoauth-mcp@1.1.11`) now reads **real** OAuth credentials from a mounted dir; the container calls `gmail.googleapis.com` directly with real tokens.

- [ ] **Step 1: Replace the credential sections**

Edit `.claude/skills/add-gmail-tool/SKILL.md`:
- Update the frontmatter `description` to drop "OneCLI-managed" → "native Google OAuth (Desktop client); real tokens live in a mounted dir, never in chat or the image".
- Replace **Phase 1: Pre-flight** entirely. Remove the `onecli apps get`, secret-mode (`onecli agents`), and `onecli-managed` stub-writing steps. New Phase 1 content (one-time, user-performed on the trusted/corp machine):

```markdown
## Phase 1: Pre-flight — one-time Google OAuth setup

1. In Google Cloud Console, create (or reuse) a project and enable the **Gmail API**.
2. Configure the OAuth consent screen (Internal if a Workspace org; otherwise External + add yourself as a test user).
3. Create an **OAuth client ID** of type **Desktop app**. Download the JSON.
4. Place it as the real OAuth keys file:

       mkdir -p ~/.gmail-mcp
       cp ~/Downloads/client_secret_*.json ~/.gmail-mcp/gcp-oauth.keys.json
       chmod 600 ~/.gmail-mcp/gcp-oauth.keys.json

5. Mint a real refresh token by running the MCP server's auth flow once (browser sign-in):

       npx @gongrzhe/server-gmail-autoauth-mcp@1.1.11 auth

   This writes a real `~/.gmail-mcp/credentials.json`. Confirm it does NOT contain
   the string `onecli-managed`:

       grep -L onecli-managed ~/.gmail-mcp/credentials.json   # prints the path = good

6. Ensure `~/.gmail-mcp` is covered by the mount allowlist (`~/.config/nanomika/mount-allowlist.json`);
   run `/manage-mounts` if not.
```
- Keep **Phase 2** (Dockerfile MCP install) — but the canonical Dockerfile changes now live in Task 4.1; this skill section can reference that the image already ships `gmail-mcp` after Phase 4.
- Keep **Phase 3** (the `ncl groups config add-mcp-server` + `.gmail-mcp` mount) verbatim — the env var paths (`GMAIL_OAUTH_PATH`, `GMAIL_CREDENTIALS_PATH`) are unchanged.
- In **Phase 5 / Troubleshooting**, replace the `401 → OneCLI isn't injecting` bullet with: `401 Unauthorized from gmail.googleapis.com → the mounted credentials.json is a stub or its refresh token expired/was revoked; re-run the auth flow in Phase 1 step 5.`
- Delete the **Notes** bullet about OneCLI stub format and the OneCLI credits/references lines.

- [ ] **Step 2: Verify no OneCLI references remain in the skill**

Run:
```bash
grep -niE "onecli" .claude/skills/add-gmail-tool/SKILL.md || echo "clean"
```
Expected: `clean`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-gmail-tool/SKILL.md
git commit -m "add-gmail-tool: rewire to native Google OAuth, drop OneCLI"
```

### Task 3.3: Rewrite `add-gcal-tool` for native Google OAuth

**Files:**
- Rewrite: `.claude/skills/add-gcal-tool/SKILL.md`

Same rewrite as Gmail, for `@cocal/google-calendar-mcp@2.6.1` reading real creds from `~/.calendar-mcp/`.

- [ ] **Step 1: Replace the credential sections**

Mirror Task 3.2 in `.claude/skills/add-gcal-tool/SKILL.md`:
- Frontmatter `description`: drop "OneCLI-managed" → "native Google OAuth".
- **Phase 1**: enable the **Google Calendar API**, reuse the same Desktop OAuth client (or a sibling), place real keys at `~/.calendar-mcp/gcp-oauth.keys.json`, mint real `~/.calendar-mcp/credentials.json`. Note that `@cocal/google-calendar-mcp` reads its token path from the `GOOGLE_CALENDAR_MCP_TOKEN_PATH` env var (already set in Phase 3's `add-mcp-server` env), so point the auth flow at the same file. Drop all `onecli apps`/`onecli agents` steps and the `onecli-managed` stub writes.
- Keep **Phase 3** (`ncl groups config add-mcp-server` for `calendar` + `.calendar-mcp` mount) verbatim.
- Troubleshooting: replace the `401 → OneCLI` bullet with the stub/expired-token wording.
- Remove OneCLI notes/credits lines.

- [ ] **Step 2: Verify clean**

```bash
grep -niE "onecli" .claude/skills/add-gcal-tool/SKILL.md || echo "clean"
```
Expected: `clean`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-gcal-tool/SKILL.md
git commit -m "add-gcal-tool: rewire to native Google OAuth, drop OneCLI"
```

### Task 3.4: Remove all other channels, providers, and misc skills

**Files:**
- Delete: the skill dirs listed below under `.claude/skills/`
- Delete: `container/skills/{vercel-cli,whatsapp-formatting,frontend-engineer}`

- [ ] **Step 1: Remove the host skill dirs**

```bash
git rm -r \
  .claude/skills/add-discord .claude/skills/add-telegram \
  .claude/skills/add-whatsapp .claude/skills/add-whatsapp-cloud \
  .claude/skills/add-teams .claude/skills/add-linear \
  .claude/skills/add-github .claude/skills/add-imessage \
  .claude/skills/add-webex .claude/skills/add-resend \
  .claude/skills/add-matrix .claude/skills/add-gchat \
  .claude/skills/add-signal .claude/skills/add-deltachat \
  .claude/skills/add-wechat .claude/skills/add-emacs \
  .claude/skills/add-opencode .claude/skills/add-ollama-provider \
  .claude/skills/add-codex .claude/skills/add-dashboard \
  .claude/skills/add-karpathy-llm-wiki .claude/skills/add-macos-statusbar \
  .claude/skills/add-mnemon .claude/skills/add-parallel \
  .claude/skills/add-rtk .claude/skills/add-vercel \
  .claude/skills/add-atomic-chat-tool .claude/skills/add-ollama-tool \
  .claude/skills/get-qodo-rules .claude/skills/qodo-pr-resolver \
  .claude/skills/x-integration
```
(All confirmed present by `ls .claude/skills/`.)

- [ ] **Step 2: Remove the unused container skills**

```bash
git rm -r container/skills/vercel-cli container/skills/whatsapp-formatting container/skills/frontend-engineer
```
Keep: `welcome`, `self-customize`, `agent-browser`, `slack-formatting`.

- [ ] **Step 3: Confirm the keep-set survives**

Run:
```bash
ls .claude/skills/ | grep -E '^add-(slack|gmail-tool|gcal-tool)$'
ls container/skills/
```
Expected: the three `add-*` keepers are listed; `container/skills/` shows exactly `agent-browser self-customize slack-formatting welcome`.

- [ ] **Step 4: Commit**

```bash
git commit -m "Remove non-essential channels, providers, and misc skills"
```

### Task 3.5: Slim the Dockerfile global installs

**Files:**
- Modify: `container/Dockerfile`

Remove the Vercel CLI (its skill is gone). The Gmail/Calendar MCP installs are added in Task 4.1.

- [ ] **Step 1: Drop the Vercel ARG and install**

In `container/Dockerfile`:
- Delete the line `ARG VERCEL_VERSION=52.2.1` (line ~24).
- In the first pnpm global-install `RUN` block (lines ~102-105), remove the `vercel` install. That block currently both writes `.npmrc` and installs vercel; rewrite it to keep only the `.npmrc` writes (the `agent-browser` and `claude-code` allowlist lines), and move the actual installs to their own blocks (the `agent-browser` and `claude-code` blocks already exist below it). New block:
```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc
```
- Update the Dockerfile header comment (lines 6-7) that lists `vercel` as a globally-installed CLI — drop `vercel` from the example list.

- [ ] **Step 2: Verify the Dockerfile no longer references vercel**

Run:
```bash
grep -niE "vercel" container/Dockerfile || echo "clean"
```
Expected: `clean`.

- [ ] **Step 3: Commit**

```bash
git add container/Dockerfile
git commit -m "Dockerfile: remove Vercel CLI global install"
```

---

## Phase 4 — Build and package the container image

### Task 4.1: Pin the base image by digest and bake in the Gmail/Calendar MCP servers

**Files:**
- Modify: `container/Dockerfile`

The image must be self-contained (Gmail + Calendar tools ship in the image) and reproducible (base pinned by digest).

- [ ] **Step 1: Resolve and pin the base image digest**

Run:
```bash
docker pull node:22-slim
docker inspect --format='{{index .RepoDigests 0}}' node:22-slim
```
Note the printed `node@sha256:…` digest. In `container/Dockerfile`, change:
```dockerfile
FROM node:22-slim
```
to (substitute the actual digest):
```dockerfile
FROM node:22-slim@sha256:<PASTE_DIGEST>
```

- [ ] **Step 2: Add the Gmail + Calendar MCP version ARGs**

After the existing `ARG BUN_VERSION=1.3.12` line, add:
```dockerfile
ARG GMAIL_MCP_VERSION=1.1.11
ARG CALENDAR_MCP_VERSION=2.6.1
```

- [ ] **Step 3: Add a pinned MCP global-install block**

After the `@anthropic-ai/claude-code` install block and before `# ---- ncl CLI wrapper`, add:
```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "@gongrzhe/server-gmail-autoauth-mcp@${GMAIL_MCP_VERSION}" \
        "@cocal/google-calendar-mcp@${CALENDAR_MCP_VERSION}" \
        "zod-to-json-schema@3.22.5"
```
(The `zod-to-json-schema@3.22.5` pin is required by the gmail MCP — see the rationale preserved in `add-gmail-tool/SKILL.md`.)

- [ ] **Step 4: Build the image cleanly**

Run:
```bash
./container/build.sh
```
Expected: completes; image `nanomika-agent:latest` exists (`docker images nanomika-agent`).

- [ ] **Step 5: Smoke-test the baked MCP binaries**

Run:
```bash
docker run --rm --entrypoint sh nanomika-agent:latest -c \
  "command -v gmail-mcp && command -v google-calendar-mcp && command -v claude && echo OK"
```
Expected: three paths printed, then `OK`. (Confirms the global installs landed on `PATH`.)

- [ ] **Step 6: Commit**

```bash
git add container/Dockerfile
git commit -m "Dockerfile: pin base by digest, bake in Gmail + Calendar MCP servers"
```

### Task 4.2: Package the image and write the corp runbook

**Files:**
- Create: `docs/corp-install.md`

- [ ] **Step 1: Save the image to a transferable tarball**

Run:
```bash
VER=$(node -p "require('./package.json').version || 'latest'")
docker save nanomika-agent:latest | gzip > nanomika-agent-${VER}.tar.gz
ls -lh nanomika-agent-${VER}.tar.gz
shasum -a 256 nanomika-agent-${VER}.tar.gz
```
Expected: a `.tar.gz` artifact + its sha256. This artifact is transferred to corp, **not** committed to git.

- [ ] **Step 2: Write the runbook**

Create `docs/corp-install.md` documenting, concretely:
- **Transfer artifacts:** the built `dist/` tarball, `nanomika-agent-<ver>.tar.gz` (+ sha256), and the repo (git clone of the `corp-trusted-install` branch).
- **Colima:** `brew install colima docker` (or pre-approved binaries); `colima start`; confirm `docker context ls` points at Colima's socket and `echo $DOCKER_HOST` (or that the default socket resolves). NanoMika's runtime detection (`src/container-runtime.ts`) uses the Docker API, which Colima serves unchanged.
- **Load the image:** `gunzip -c nanomika-agent-<ver>.tar.gz | docker load`; verify with `docker images nanomika-agent`.
- **Install host deps:** `pnpm install --prod --frozen-lockfile` (runs the vendored-binary postinstall; no compilation, no GitHub fetch).
- **Credentials:** put the Anthropic key/token in `.env` (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`); Slack tokens in `.env`; real Google OAuth creds in `~/.gmail-mcp/` and `~/.calendar-mcp/` per the (rewritten) Gmail/Calendar skills.
- **Slack ingress:** record the resolved approach from Task 3.1's risk note (public webhook vs Socket Mode).
- **Run:** `node dist/index.js` (or the service); the one-time setup runs via `node dist/setup/index.js` after Task 5.2 lands.

- [ ] **Step 3: Commit (runbook only — not the tarball)**

```bash
git add docs/corp-install.md
git commit -m "Add corp install runbook (docker load + Colima + prod install)"
```

---

## Phase 5 — Auditable trusted-package manifest

### Task 5.1: Emit `dist/setup/` so corp runs setup without `tsx`

**Files:**
- Create: `tsconfig.setup.json`
- Modify: `package.json` (`scripts.build`)

`tsconfig.json` has `rootDir: ./src` + `include: [src/**/*]`, so `tsc` does **not** emit `setup/`. Corp must not depend on `tsx` (a heavy esbuild dev dep). Build `setup/` to `dist/setup/`.

- [ ] **Step 1: Add a setup tsconfig**

Create `tsconfig.setup.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist",
    "noEmit": false
  },
  "include": ["setup/**/*", "src/**/*"]
}
```
(Including `src/**/*` covers setup's imports of `../src/log.js` etc. With `rootDir: "."`, output lands at `dist/setup/…` and `dist/src/…`; the existing `dist/<file>.js` from the main build is unaffected because the two tsconfigs share `outDir` but `tsc -b`/sequential runs merge outputs.)

- [ ] **Step 2: Chain the setup build into `build`**

In `package.json`, change:
```json
    "build": "tsc",
```
to:
```json
    "build": "tsc && tsc -p tsconfig.setup.json",
```

- [ ] **Step 3: Verify setup compiles to dist and runs on Node (no tsx)**

Run:
```bash
pnpm run build
ls dist/setup/index.js dist/setup/auth.js
node dist/setup/auth.js --check
```
Expected: the files exist; `node dist/setup/auth.js --check` emits an `AUTH` status block (no `tsx`, no crash). If module-resolution errors appear (`.js` extension imports across `dist/setup` ↔ `dist/src`), confirm the relative import depths still resolve under the `dist/` layout; adjust the `include`/`rootDir` only if a concrete error demands it.

- [ ] **Step 4: Commit**

```bash
git add tsconfig.setup.json package.json
git commit -m "Build setup/ to dist so corp runs setup without tsx"
```

### Task 5.2: Generate the auditable package manifest

**Files:**
- Create: `scripts/gen-trusted-manifest.mjs`
- Create: `docs/trusted-package-manifest.md` (generated)

- [ ] **Step 1: Write the generator**

Create `scripts/gen-trusted-manifest.mjs`:
```javascript
#!/usr/bin/env node
// Emit the auditable trusted-package manifest for corp security review:
//   - host production dependencies (resolved versions from the lockfile)
//   - the vendored native binary (name/version/sha256)
//   - the container image's pinned global installs + base-image digest
// Pure Node, no deps. Run: node scripts/gen-trusted-manifest.mjs > docs/trusted-package-manifest.md
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const prodDeps = Object.entries(pkg.dependencies ?? {}).sort();

function sha256(path) {
  return existsSync(path)
    ? execSync(`shasum -a 256 ${path}`).toString().split(/\s+/)[0]
    : 'MISSING';
}

// Container image: pull the pinned ARG/FROM lines straight from the Dockerfile.
const dockerfile = readFileSync('container/Dockerfile', 'utf8');
const pins = dockerfile
  .split('\n')
  .filter((l) => /^FROM |^ARG \w+_VERSION=/.test(l.trim()))
  .map((l) => l.trim());

const out = [];
out.push('# Trusted Package Manifest');
out.push('');
out.push('> Auditable list of every pinned package + version in the corp install path.');
out.push('> Regenerate with `node scripts/gen-trusted-manifest.mjs > docs/trusted-package-manifest.md`.');
out.push('');
out.push('## Host production dependencies (npm registry)');
out.push('');
out.push('| Package | Range (package.json) |');
out.push('|---|---|');
for (const [name, range] of prodDeps) out.push(`| ${name} | ${range} |`);
out.push('');
out.push('Exact resolved versions are pinned in `pnpm-lock.yaml` and installed with');
out.push('`pnpm install --prod --frozen-lockfile` under `minimumReleaseAge: 4320`.');
out.push('');
out.push('## Vendored native binary (no compile, no fetch on corp)');
out.push('');
out.push('| File | Target | sha256 |');
out.push('|---|---|---|');
out.push(
  `| vendor/better-sqlite3/better_sqlite3.node | better-sqlite3@11.10.0, Node ABI 127 darwin-arm64 | ${sha256('vendor/better-sqlite3/better_sqlite3.node')} |`,
);
out.push('');
out.push('## Container image (built here, `docker load`ed on corp)');
out.push('');
out.push('```');
for (const p of pins) out.push(p);
out.push('```');
out.push('');
console.log(out.join('\n'));
```

- [ ] **Step 2: Generate the manifest**

Run:
```bash
node scripts/gen-trusted-manifest.mjs > docs/trusted-package-manifest.md
cat docs/trusted-package-manifest.md
```
Expected: a manifest listing the host prod deps (`@clack/core`, `@clack/prompts`, `better-sqlite3`, `chat`, `cron-parser`, `kleur`, `@chat-adapter/slack`), the vendored binary with a real sha256, and the Dockerfile's `FROM …@sha256` + `*_VERSION` ARGs.

- [ ] **Step 3: Sanity-check completeness**

Run:
```bash
# Every prod dep in package.json must appear in the manifest:
node -e "const p=require('./package.json');const m=require('fs').readFileSync('docs/trusted-package-manifest.md','utf8');const miss=Object.keys(p.dependencies||{}).filter(d=>!m.includes(d));console.log(miss.length?('MISSING: '+miss.join(',')):'all prod deps listed')"
```
Expected: `all prod deps listed`.

- [ ] **Step 4: Commit**

```bash
git add scripts/gen-trusted-manifest.mjs docs/trusted-package-manifest.md
git commit -m "Add auditable trusted-package manifest + generator"
```

---

## Success criteria (final verification)

Run this gauntlet on the trusted machine before declaring the work done; the corp-side equivalents are in `docs/corp-install.md`.

- [ ] **No build scripts / clean prod install:**
```bash
rm -rf node_modules && pnpm install --prod --frozen-lockfile 2>&1 | tee /tmp/prod.log
grep -i "node-gyp\|prebuild-install\|running.*install script" /tmp/prod.log || echo "NO BUILD SCRIPTS"
node -e "require('better-sqlite3'); console.log('sqlite OK')"
```
Expected: `NO BUILD SCRIPTS`, `sqlite OK`.

- [ ] **No OneCLI / no curl|sh anywhere in the install path:**
```bash
grep -rniE "onecli|curl -fsSL|curl .*\| *sh" src/ setup/ container/Dockerfile container/build.sh package.json | grep -viE "^\s*//|^\s*\*" || echo "clean"
```
Expected: `clean`.

- [ ] **Host boots with the proxy + Slack + dist:**
```bash
pnpm install --frozen-lockfile && pnpm run build && pnpm test
node dist/index.js  # ctrl-C after confirming: credential proxy starts, Slack connects, no OneCLI errors in logs/
```
Expected: tests green; on boot, `logs/nanomika.log` shows the credential proxy listening and the Slack adapter registering; no OneCLI references.

- [ ] **Image is self-contained:** Task 4.1 Step 5 smoke test passes (gmail-mcp, google-calendar-mcp, claude on PATH).

- [ ] **Manifest accounts for every package:** Task 5.2 Step 3 prints `all prod deps listed`.

---

## Open items / risks (carried from the design)

- **Slack ingress on a locked-down laptop** — public webhook may be blocked; confirm Socket Mode support in `@chat-adapter/slack@4.27.0` (Task 3.1 risk note). Record the resolution in `docs/corp-install.md`.
- **Exact Slack env-var set** — `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` confirmed from `add-slack`; add `SLACK_APP_TOKEN` if Socket Mode is used.
- **Container egress to `*.googleapis.com`** — without OneCLI interception the container calls Google directly; confirm the container network policy allows it (it should; only Anthropic traffic is proxied).
- **Prebuilt ABI vs corp arch** — the vendored `.node` is Node-22/darwin-arm64; valid only if corp is Apple silicon on Node 22. If corp is Intel, vendor a `darwin-x64` build too and select by `process.arch` in `scripts/vendor-better-sqlite3.mjs`.
- **`dist/setup` module resolution** — Task 5.1 Step 3 verifies; adjust `tsconfig.setup.json` only if a concrete resolution error surfaces.

## Out of scope

- Gmail as an inbound polling channel (kept as a tool).
- Porting the host to Bun + `bun:sqlite`.
- Any upstream merge/sync (private hard fork).
```
