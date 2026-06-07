# Corp Trusted-Install Runbook

How to stand up NanoMika on a locked-down corporate laptop (macOS, Apple silicon,
Node 22) with **no install-time arbitrary code execution, no GitHub-branch
fetches, and no compilation** — pulling only pinned, prebuilt packages from the
default npm registry, plus a container image built off-corp and transferred as a
tarball.

Scope of this build: host credential proxy (no OneCLI), Slack (two-way), Gmail
(tool), Google Calendar (tool). See
`docs/trusted-package-manifest.md` for the full pinned-package audit list.

---

## 0. Artifacts to transfer

Move these to the corp laptop out-of-band (the security-approved transfer
channel — they are **not** in git):

| Artifact | What it is |
|---|---|
| Git checkout of the `corp-trusted-install` branch | the host source + vendored binary + pinned lockfile |
| `nanomika-agent-<ver>.tar.gz` (+ its sha256) | the prebuilt agent container image (`docker save \| gzip`) |
| The Anthropic credential, Slack tokens, Google OAuth client JSON | secrets — never in git, see §5 |

`<ver>` is `package.json`'s `version` (e.g. `2.0.70`). Verify the image tarball
on arrival:

```bash
shasum -a 256 nanomika-agent-<ver>.tar.gz   # must match the sha recorded at build time
```

---

## 1. Container runtime — Colima

NanoMika's runtime detection (`src/container-runtime.ts`) talks to the Docker
API. Colima serves that API unchanged, so no NanoMika code changes are needed.

```bash
brew install colima docker        # or pre-approved binaries
colima start
docker context ls                 # confirm the active context points at Colima's socket
docker info                       # must succeed (daemon reachable)
```

On macOS the credential proxy binds to `127.0.0.1` and the container reaches the
host via `host.docker.internal` (`src/container-runtime.ts`) — Colima's VM routes
this to the host loopback, same as Docker Desktop. No extra wiring.

---

## 2. Load the prebuilt image (no build, no registry pull on corp)

```bash
gunzip -c nanomika-agent-<ver>.tar.gz | docker load
docker images | grep nanomika-agent     # note the loaded repo:tag
```

**Important — retag to this checkout's slug.** The image tag is derived from the
**build machine's** project path (`container_image_base()` in
`setup/lib/install-slug.sh`), so the tarball loads as something like
`nanomika-agent-v2-<hash>:latest` from the build host. The corp host computes its
**own** slug from the corp checkout path and looks for the image under that name.
Retag the loaded image to match:

```bash
# From the corp checkout root:
CORP_IMG="$(source setup/lib/install-slug.sh && container_image_base)"
LOADED_IMG="$(docker images --format '{{.Repository}}' | grep '^nanomika-agent' | head -1)"
docker tag "${LOADED_IMG}:latest" "${CORP_IMG}:latest"
docker images "${CORP_IMG}"             # confirm the expected tag now exists
```

(Alternatively, clone into the exact same absolute path the image was built from,
and the slugs match with no retag.)

Smoke-test the baked tools:

```bash
docker run --rm --entrypoint sh "${CORP_IMG}:latest" -c \
  "command -v gmail-mcp && command -v google-calendar-mcp && command -v claude && echo OK"
```

---

## 3. Install host dependencies (zero compile, zero fetch beyond npm)

```bash
nvm use 22                                  # or otherwise ensure Node 22.x (engines pins 22.x)
pnpm install --prod --frozen-lockfile
```

This:
- installs only pinned versions from the lockfile under the `minimumReleaseAge`
  gate,
- runs **no** third-party build scripts (`better-sqlite3` is no longer in
  `onlyBuiltDependencies`; pnpm prints "Ignored build scripts: better-sqlite3"),
- runs our own auditable `postinstall` (`scripts/vendor-better-sqlite3.mjs`),
  which copies the vendored prebuilt `vendor/better-sqlite3/better_sqlite3.node`
  into place — so SQLite needs no `node-gyp` / `prebuild-install` / GitHub fetch.

Verify:

```bash
node -e "const D=require('better-sqlite3'); const db=new D(':memory:'); console.log('sqlite', db.prepare('select sqlite_version() v').get().v); db.close();"
```

The prebuilt is Node-ABI-127 / **darwin-arm64**. It is valid only on Apple-silicon
Node 22. If corp turns out to be Intel, vendor a `darwin-x64` build too and select
by `process.arch` in `scripts/vendor-better-sqlite3.mjs`.

---

## 4. Build the host TypeScript (host + setup)

```bash
pnpm run build           # emits dist/ (host) and dist/setup/ (setup CLI)
```

`dist/setup/` lets you run setup steps with plain `node` — no `tsx`/esbuild dev
dependency on corp.

---

## 5. Credentials

All credentials live on the host; none are baked into the image or passed through
chat. The host-side credential proxy (`src/credential-proxy.ts`) injects the
Anthropic credential into outbound API requests.

**Anthropic** — write to `.env` (the proxy reads `ANTHROPIC_API_KEY` /
`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN`):

```bash
node dist/setup/index.js --step auth -- --create --value "<sk-ant-… or sk-ant-oat… token>"
node dist/setup/index.js --step auth -- --check        # expect STATUS: success
```

**Slack** — also in `.env`. See §6 for which tokens.

**Google (Gmail + Calendar)** — real OAuth Desktop-client credentials in mounted
dirs, per the rewritten skills:
- Gmail: `~/.gmail-mcp/gcp-oauth.keys.json` + `~/.gmail-mcp/credentials.json`
  (`/add-gmail-tool` Phase 1).
- Calendar: `~/.calendar-mcp/gcp-oauth.keys.json` + `~/.calendar-mcp/credentials.json`
  (`/add-gcal-tool` Phase 1).

Ensure both dirs are on the mount allowlist (`/manage-mounts`). The container
calls `*.googleapis.com` directly with the real token — confirm the corp network
policy allows egress to `gmail.googleapis.com` / `calendar.googleapis.com` /
`oauth2.googleapis.com`. (Only Anthropic traffic is proxied; Google traffic is
direct.)

---

## 6. Slack ingress — use Socket Mode (no public webhook)

**Resolution of the ingress question:** `@chat-adapter/slack@4.27.0` supports
**Socket Mode** (outbound WebSocket via an app-level `xapp-` token), and
`src/channels/slack.ts` engages it automatically when `SLACK_APP_TOKEN` is set.
This needs **no inbound webhook**, so it works on a locked-down laptop where a
public `/webhook/slack` endpoint is blocked.

In your Slack app config: enable Socket Mode, create an app-level token with the
`connections:write` scope (the `xapp-…` token), and install the app to get the
bot token (`xoxb-…`). Then in `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…
# SLACK_SIGNING_SECRET is NOT needed in Socket Mode.
```

Webhook mode remains the fallback: omit `SLACK_APP_TOKEN` and instead set
`SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET`, and expose a public
`/webhook/slack` (port 3000). On corp, prefer Socket Mode.

---

## 7. Run

One-time setup (interactive flow, no OneCLI step):

```bash
node dist/setup/index.js          # or step-by-step via --step <name>
```

Start the host:

```bash
node dist/index.js
```

On boot, `logs/nanomika.log` should show the credential proxy listening and the
Slack adapter registering — and no OneCLI references anywhere. For always-on
operation, wire the launchd/systemd service per the platform notes in the main
README.

---

## 8. Final verification (corp-side)

```bash
# No build scripts ran during the prod install:
rm -rf node_modules && pnpm install --prod --frozen-lockfile 2>&1 | tee /tmp/prod.log
grep -i "node-gyp\|prebuild-install\|running.*install script" /tmp/prod.log || echo "NO BUILD SCRIPTS"
node -e "require('better-sqlite3'); console.log('sqlite OK')"

# Image is self-contained:
docker run --rm --entrypoint sh "${CORP_IMG}:latest" -c \
  "command -v gmail-mcp && command -v google-calendar-mcp && command -v claude && echo OK"
```

Expected: `NO BUILD SCRIPTS`, `sqlite OK`, three tool paths + `OK`.
