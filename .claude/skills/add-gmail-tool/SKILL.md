---
name: add-gmail-tool
description: Add Gmail as an MCP tool (read, search, send, label, draft) using native Google OAuth (Desktop client). Real tokens live in a mounted dir on the host, never in chat or the image; the container calls gmail.googleapis.com directly with the real token.
---

# Add Gmail Tool (native Google OAuth)

This skill wires the [`@gongrzhe/server-gmail-autoauth-mcp`](https://www.npmjs.com/package/@gongrzhe/server-gmail-autoauth-mcp) stdio MCP server into selected agent groups. The MCP server reads **real** OAuth credentials from a host directory mounted into the container (`~/.gmail-mcp/`) and calls `gmail.googleapis.com` directly with the real bearer token.

Tools exposed (from `gmail-mcp@1.1.11`, surfaced to the agent as `mcp__gmail__<name>`): `search_emails`, `read_email`, `send_email`, `draft_email`, `delete_email`, `modify_email`, `batch_modify_emails`, `batch_delete_emails`, `download_attachment`, `list_email_labels`, `create_label`, `update_label`, `delete_label`, `get_or_create_label`, `list_filters`, `get_filter`, `create_filter`, `create_filter_from_template`, `delete_filter`.

**Why this pattern:** the credentials never reach chat or the container image. They live in a host-side directory that is mounted into the container read/write at spawn time, so the OAuth keys and refresh token stay on the host filesystem and are only visible to the agent group(s) you explicitly wire.

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

   This writes a real `~/.gmail-mcp/credentials.json`. Confirm it holds a real
   refresh token (Google installed-app refresh tokens start with `1//`), not a
   placeholder:

       grep -q '"refresh_token": *"1//' ~/.gmail-mcp/credentials.json && echo "real token present"

6. Ensure `~/.gmail-mcp` is covered by the mount allowlist (`~/.config/nanomika/mount-allowlist.json`);
   run `/manage-mounts` if not.

## Phase 2: Apply Code Changes

> **On the corp trusted-install image, gmail-mcp is already baked into the image**
> (see `container/Dockerfile`, pinned via `GMAIL_MCP_VERSION`). If `gmail-mcp` is
> already on `PATH` in the image, skip straight to Phase 3 — there is no Dockerfile
> edit to make. The steps below are for installs whose image does not yet ship it.

### Check if already applied

```bash
grep -q 'GMAIL_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED — skip to Phase 3"
```

### Add MCP server to Dockerfile

Edit `container/Dockerfile`. Find the pinned-version ARG block:

```dockerfile
ARG CLAUDE_CODE_VERSION=2.1.116
ARG AGENT_BROWSER_VERSION=latest
ARG BUN_VERSION=1.3.12
```

Add a new line:

```dockerfile
ARG GMAIL_MCP_VERSION=1.1.11
```

Then find the last pnpm global-install `RUN` block (the one that installs `@anthropic-ai/claude-code`) and add a new block after it, before `# ---- Entrypoint`:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "@gongrzhe/server-gmail-autoauth-mcp@${GMAIL_MCP_VERSION}" \
        "zod-to-json-schema@3.22.5"
```

Pinned version matters — `minimumReleaseAge` in `pnpm-workspace.yaml` gates trunk installs, and CLAUDE.md requires a fixed ARG version for all Node CLIs installed into the image.

**Why the `zod-to-json-schema` pin:** `@gongrzhe/server-gmail-autoauth-mcp@1.1.11` has loose deps (`zod-to-json-schema: ^3.22.1`, `zod: ^3.22.4`). pnpm resolves `zod-to-json-schema` to the latest 3.25.x, which imports `zod/v3` — a subpath that only exists in `zod>=3.25`. But `zod` resolves to `3.24.x` (highest satisfying `^3.22.4` without breaking peer ranges). Result: `ERR_PACKAGE_PATH_NOT_EXPORTED` at import time. Pinning `zod-to-json-schema` to a pre-v3-subpath version avoids it. Re-check if you bump `GMAIL_MCP_VERSION`.

**No `TOOL_ALLOWLIST` edit needed.** `container/agent-runner/src/providers/claude.ts` derives the allow-pattern dynamically from each group's `mcpServers` map (`Object.keys(this.mcpServers).map(mcpAllowPattern)`), so registering `gmail` in Phase 3 automatically allows `mcp__gmail__*`. Earlier versions of this skill instructed a static `TOOL_ALLOWLIST` edit — that's now redundant.

### Rebuild the container image

```bash
./container/build.sh
```

Must complete cleanly. The new `pnpm install -g` layer is ~60s first time (cached on rebuild).

## Phase 3: Wire Per-Agent-Group

For each agent group that should have Gmail (ask the user — typically their personal DM and CLI agents, sometimes shared household agents), persist two changes to the **central DB** (`data/v2.db`): the `mcpServers.gmail` entry and an `additionalMounts` entry for `.gmail-mcp`. Both flow through `materializeContainerJson` on every spawn, so editing `groups/<folder>/container.json` by hand does **not** stick — that file is regenerated from the DB.

### List groups, pick which ones get Gmail

```bash
ncl groups list
```

### Register the MCP server

For each chosen `<group-id>`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name gmail \
  --command gmail-mcp \
  --args '[]' \
  --env '{"GMAIL_OAUTH_PATH":"/workspace/extra/.gmail-mcp/gcp-oauth.keys.json","GMAIL_CREDENTIALS_PATH":"/workspace/extra/.gmail-mcp/credentials.json"}'
```

Approval behaviour depends on where you run it: from inside an agent's container `ncl` write verbs are approval-gated (admin approves before it lands); from a host operator shell with full scope, it executes immediately. Either way, the response tells you which path it took.

### Add the `.gmail-mcp` mount

There is no `ncl groups config add-mount` verb yet (tracked in [#2395](https://github.com/nanocoai/nanomika/issues/2395)). Until that ships, edit the DB directly via the in-tree wrapper (`scripts/q.ts` — `setup/verify.ts:5` codifies that NanoMika avoids depending on the `sqlite3` CLI binary, so don't shell out to it):

```bash
GROUP_ID='<group-id>'
HOST_PATH="$HOME/.gmail-mcp"
MOUNT=$(jq -cn --arg h "$HOST_PATH" '{hostPath:$h, containerPath:".gmail-mcp", readonly:false}')
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
  SET additional_mounts = json_insert(additional_mounts, '\$[#]', json('$MOUNT')), \
      updated_at = datetime('now') \
  WHERE agent_group_id = '$GROUP_ID';"
```

Run from your NanoMika project root (where `data/v2.db` lives). The `$[#]` placeholder is SQLite JSON1's append-to-end notation; it's `\$`-escaped so bash doesn't arithmetic-expand it before sqlite sees it. `updated_at` is ISO-string everywhere else in the schema, so use `datetime('now')` — not `strftime('%s','now')`, which would silently mix epoch ints into a column of YYYY-MM-DD HH:MM:SS strings.

**Switch to `ncl groups config add-mount` once #2395 lands.** Update this skill at that time.

**Why the container path is relative:** `mount-security` rejects absolute `containerPath` values. Additional mounts are prefixed with `/workspace/extra/`, so `containerPath: ".gmail-mcp"` lands at `/workspace/extra/.gmail-mcp`. The MCP server's `GMAIL_OAUTH_PATH` / `GMAIL_CREDENTIALS_PATH` env vars point at that absolute location inside the container.

**Why this can't be `groups/<folder>/container.json`:** post-migration `014-container-configs`, `materializeContainerJson` in `src/container-config.ts` rewrites that file from the DB on every spawn. Anything hand-edited there is silently overwritten on next restart.

## Phase 4: Build and Restart

```bash
pnpm run build
```

Run from your NanoMika project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

## Phase 5: Verify

### Test from the wired agent

Tell the user:

> In your `<agent-name>` chat, send: **"list my gmail labels"** or **"search my inbox for invoices from last month"**.
>
> The agent should use `mcp__gmail__list_labels` / `mcp__gmail__search`. The first call may take a second or two while the MCP server starts and Google validates the token.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanomika.log logs/nanomika.error.log | grep -iE 'gmail|mcp'
# Per-container logs — session-scoped:
ls data/v2-sessions/*/stderr.log | head
```

Common signals:
- `command not found: gmail-mcp` → image wasn't rebuilt or PATH doesn't include `/pnpm` (should — `ENV PATH="$PNPM_HOME:$PATH"` in Dockerfile).
- `ENOENT: no such file or directory, open '/workspace/extra/.gmail-mcp/credentials.json'` → mount is missing. Check `~/.config/nanomika/mount-allowlist.json` includes a parent of `~/.gmail-mcp`.
- `401 Unauthorized` from `gmail.googleapis.com` → the mounted `credentials.json` is a stub or its refresh token expired/was revoked; re-run the auth flow in Phase 1 step 5.
- Agent says "I don't have Gmail tools" → the `gmail` MCP server isn't registered in this group's `mcpServers` (re-run the `ncl groups config add-mcp-server` step in Phase 3 for that group and restart it), or the agent-runner image is stale (rebuild with `./container/build.sh`, with `--no-cache` if suspicious).

## Removal

1. For each group that had Gmail wired, remove the MCP server from the DB:
   ```bash
   ncl groups config remove-mcp-server --id <group-id> --name gmail
   ```
2. Remove the `.gmail-mcp` mount from the DB (no `remove-mount` verb yet — same #2395 dependency):
   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
     SET additional_mounts = (SELECT json_group_array(value) FROM json_each(additional_mounts) \
                              WHERE json_extract(value, '\$.containerPath') != '.gmail-mcp'), \
         updated_at = datetime('now') \
     WHERE agent_group_id = '<group-id>';"
   ```
3. Remove the `GMAIL_MCP_VERSION` ARG and the `pnpm install -g @gongrzhe/server-gmail-autoauth-mcp` block from `container/Dockerfile`.
4. `pnpm run build && ./container/build.sh && systemctl --user restart "$(. setup/lib/install-slug.sh && systemd_unit)"`.
5. (Optional) `rm -rf ~/.gmail-mcp/` if no other host-side tool needs the real OAuth credentials. These are real tokens — shred rather than leave them lying around if you're decommissioning.

No `TOOL_ALLOWLIST` removal step — Phase 2 no longer edits it.

## Notes

- **Scopes are set at OAuth consent time.** If the agent needs scopes beyond what you granted during the Phase 1 auth flow (e.g. the user later wants `calendar.readonly` for combined email/calendar workflows), re-run the auth flow with the expanded scope set so a fresh `credentials.json` with the new grant is written.
- **This is tool-only.** Inbound email as a channel (emails trigger the agent) is a separate piece of work — it needs a `src/channels/gmail.ts` adapter that polls the inbox and routes to a messaging group. It has not been ported to v2's channel architecture.

## Credits & references

- **MCP server:** [`@gongrzhe/server-gmail-autoauth-mcp`](https://github.com/GongRzhe/Gmail-MCP-Server) by GongRzhe — MIT-licensed.
- **Skill pattern:** modeled on [`add-gcal-tool`](../add-gcal-tool/SKILL.md).
