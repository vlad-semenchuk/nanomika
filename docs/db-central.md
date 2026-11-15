# NanoMika — Central DB Schema

Complete reference for `data/v2.db`, the host-owned admin-plane database. Start with [db.md](db.md) for the three-DB overview, the map, and the cross-mount rules.

Access layer: `src/db/` plus the module DB helpers under `src/modules/permissions/db/` and `src/modules/agent-to-agent/db/`. The schema is defined by the migrations in `src/db/migrations/`; there is no separate schema file for the central DB.

---

## 1. Tables

### 1.1 `agent_groups`

Agent workspaces. Each maps 1:1 to a `groups/<folder>/` directory holding the composed `CLAUDE.md`, the per-group `CLAUDE.local.md` memory and the materialized `container.json`. Container config lives in `container_configs` (see §1.17 below); the `container.json` file is materialized at spawn time for the container runner to read. The first agent group (folder `main`) is created by `src/bootstrap.ts` on first start.

```sql
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,
  created_at       TEXT NOT NULL
);
```

- **Readers:** `src/session-manager.ts`, `src/delivery.ts`, `src/router.ts`
- **Writers:** `src/db/agent-groups.ts` (called from `src/bootstrap.ts`, the `create_agent` action in `src/modules/agent-to-agent/create-agent.ts`, and channel approval in `src/modules/permissions/channel-approval.ts`), `ncl groups`

### 1.2 `messaging_groups`

One row per platform chat (the local CLI chat — `channel_type = 'cli'`, `platform_id = 'local'` — one Slack channel, one 1:1 DM, etc.).

```sql
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
  created_at            TEXT NOT NULL,
  denied_at             TEXT,               -- added by migration channel-registration
  UNIQUE(channel_type, platform_id)
);
```

- `unknown_sender_policy`: `strict` (drop), `request_approval` (ask admin), `public` (allow).
- `denied_at`: set when an admin denies an unknown-channel registration; the router then drops messages from that chat without asking again.
- **Readers:** `src/router.ts`, `src/delivery.ts`, `src/session-manager.ts`
- **Writers:** `src/db/messaging-groups.ts` (called from `src/bootstrap.ts`, router auto-create, `ensureUserDm()`), `ncl messaging-groups`

### 1.3 `messaging_group_agents`

Wiring: which agent group handles which messaging group. Many-to-many — the same channel can route to multiple agents (see [isolation-model.md](isolation-model.md)).

```sql
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  engage_mode            TEXT,   -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,   -- regex; required when engage_mode='pattern'; '.' = every message
  sender_scope           TEXT,   -- 'all' | 'known'
  ignored_message_policy TEXT,   -- 'drop' | 'accumulate'
  UNIQUE(messaging_group_id, agent_group_id)
);
```

Column order and nullability reflect the migrations: 001 created the table, and migration `engage-modes` added the four `engage_*` / `sender_scope` / `ignored_message_policy` columns with `ALTER TABLE ADD COLUMN` (no SQL defaults) and dropped the original `trigger_rules` and `response_scope` columns. Callers always supply values: `ncl wirings create` defaults to `mention` / `all` / `drop`, and `src/bootstrap.ts` wires the CLI chat with `engage_mode = 'pattern'`, `engage_pattern = '.'`. `src/db/schema.ts` shows the intended shape with `NOT NULL DEFAULT`s, which the live table does not have.

- `session_mode`: `shared` (one session per channel), `per-thread` (one per thread), `agent-shared` (one per agent group across all channels). A threaded adapter in a group chat forces per-thread sessions regardless (except `agent-shared`).
- `priority`: wirings for a messaging group are read in `priority DESC` order.
- **Side effect:** `createMessagingGroupAgent()` in `src/db/messaging-groups.ts` also inserts the matching `agent_destinations` row (see §1.10). The generic `ncl wirings create` inserts only the wiring row; add a destination with `ncl destinations add` if the agent must send to that chat when it is not the session's origin chat.

### 1.4 `users`

Platform user identities. ID is namespaced `<channel>:<handle>`, e.g. `cli:local` (created by `src/bootstrap.ts`) or `slack:U012ABC`. One human may own several rows — no cross-channel linking yet.

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);
```

- **Writers/readers:** `src/modules/permissions/db/users.ts` (sender resolution in `src/modules/permissions/index.ts`, `src/bootstrap.ts`), `ncl users`

### 1.5 `user_roles`

Permissions. **Privilege is user-level, never agent-group-level.**

```sql
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);
```

Invariants:
- `role = 'owner'` → must be global (`agent_group_id IS NULL`). Enforced in `grantRole()`. `src/bootstrap.ts` grants `cli:local` the global owner role on first start.
- `role = 'admin'` → global (NULL) or scoped to one agent group.
- Admin @ A implies membership in A — no `agent_group_members` row required.

Access layer: `src/modules/permissions/db/user-roles.ts`, `src/modules/permissions/access.ts`.

### 1.6 `agent_group_members`

Explicit membership for non-privileged users. Owner and admins don't need rows here — they're implicit members.

```sql
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);
```

Access layer: `src/modules/permissions/db/agent-group-members.ts`, `ncl members`.

### 1.7 `user_dms`

Cache of DM channel discovery. Lets the host send a cold DM (approval card) without hitting the platform's `openConversation` API every time.

```sql
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);
```

Populated lazily by `ensureUserDm()` in `src/modules/permissions/user-dm.ts`.

### 1.8 `sessions`

Session registry. One row per (agent group, messaging group, thread) tuple subject to `session_mode`. Stores lifecycle metadata only — no messages.

```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup     ON sessions(messaging_group_id, thread_id);
```

- **Resolved by:** `resolveSession()` in `src/session-manager.ts`.
- Creating a session also provisions the session folder and both session DBs via `initSessionFolder()` — see [db-session.md](db-session.md).

### 1.9 `pending_questions`

When the agent's `ask_user_question` card is delivered, `src/delivery.ts` records it here (`createPendingQuestion()`). When the user clicks an option, `src/modules/interactive/index.ts` looks the row up by `questionId`, writes a `system` response message into the session's `inbound.db`, wakes the container and deletes the row.

```sql
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
```

### 1.10 `agent_destinations`

Permission ACL *and* name-resolution map for outbound sending. An agent asking to `send_message(to="dev-channel")` must have a row here with `local_name = 'dev-channel'`, or the send is rejected as `unknown destination`.

```sql
CREATE TABLE agent_destinations (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  local_name     TEXT NOT NULL,
  target_type    TEXT NOT NULL,   -- 'channel' | 'agent'
  target_id      TEXT NOT NULL,   -- messaging_group_id | agent_group_id
  created_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, local_name)
);
CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);
```

**Projection invariant (load-bearing).** The central table is the source of truth, but each running container reads from a projection in its own `inbound.db` (see [db-session.md §2.3](db-session.md#23-destinations)). Any code that mutates `agent_destinations` while a container is running must also call `writeDestinations()` (`src/modules/agent-to-agent/write-destinations.ts`) or the container will reject sends with stale data. Known call sites: container spawn in `src/container-runner.ts`, the `create_agent` action in `src/modules/agent-to-agent/create-agent.ts`, and `ncl destinations add/remove` (`src/cli/resources/destinations.ts`). `createMessagingGroupAgent()` in `src/db/messaging-groups.ts` writes the central row only; a running container picks it up on its next wake.

Access layer: `src/modules/agent-to-agent/db/agent-destinations.ts`.

### 1.11 `pending_approvals`

Host-side record for an approval-requiring request raised through `requestApproval()` in `src/modules/approvals/primitive.ts`. The only caller today is `src/cli/dispatch.ts`, for approval-gated `ncl` commands issued from inside a container (`action = 'cli_command'`). `session_id` is set to the requesting session.

```sql
CREATE TABLE pending_approvals (
  approval_id         TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(id),
  request_id          TEXT NOT NULL,
  action              TEXT NOT NULL,
  payload             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  agent_group_id      TEXT REFERENCES agent_groups(id),
  channel_type        TEXT,
  platform_id         TEXT,
  platform_message_id TEXT,
  expires_at          TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  title               TEXT NOT NULL DEFAULT '',
  options_json        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_pending_approvals_action_status ON pending_approvals(action, status);
```

- Rows are deleted by `src/modules/approvals/response-handler.ts` once the admin answers; `status` is always written as `pending`.
- `agent_group_id`, `channel_type`, `platform_id`, `platform_message_id` and `expires_at` exist in the schema but nothing sets them (always NULL), and `updatePendingApprovalStatus()` has no callers.
- Access layer: `src/db/sessions.ts`; read-only listing: `ncl approvals`.

### 1.12 `unregistered_senders`

Audit trail: every time a message gets dropped (unknown sender, strict policy), we increment a counter here so admins can see who's been trying to knock.

```sql
CREATE TABLE unregistered_senders (
  channel_type       TEXT NOT NULL,
  platform_id        TEXT NOT NULL,
  user_id            TEXT,
  sender_name        TEXT,
  reason             TEXT NOT NULL,
  messaging_group_id TEXT,
  agent_group_id     TEXT,
  message_count      INTEGER NOT NULL DEFAULT 1,
  first_seen         TEXT NOT NULL,
  last_seen          TEXT NOT NULL,
  PRIMARY KEY (channel_type, platform_id)
);
CREATE INDEX idx_unregistered_senders_last_seen ON unregistered_senders(last_seen);
```

Writer: `recordDroppedMessage()` in `src/db/dropped-messages.ts`, called from `src/router.ts` and `src/modules/permissions/index.ts`. On conflict, bumps `message_count` + `last_seen`. Read with `ncl dropped-messages list`.

### 1.13 Chat SDK bridge tables

State backing the `SqliteStateAdapter` used by the Chat SDK bridge (`src/channels/chat-sdk-bridge.ts`; see [api-details.md](api-details.md)). NanoMika code rarely touches these directly — they're owned by `src/state-sqlite.ts`. They are only written when a Chat SDK–based channel (such as `src/channels/slack.ts`) is enabled; the default CLI channel does not use them.

```sql
CREATE TABLE chat_sdk_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER                    -- unix ts, nullable
);

CREATE TABLE chat_sdk_subscriptions (
  thread_id     TEXT PRIMARY KEY,
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_sdk_locks (
  thread_id  TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE chat_sdk_lists (
  key        TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (key, idx)
);
```

### 1.14 `schema_version`

Migration ledger, written by the migration runner (§2).

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  applied TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_schema_version_name ON schema_version(name);
```

### 1.15 `pending_sender_approvals`

In-flight state for the unknown-sender approval flow (`unknown_sender_policy = 'request_approval'`). One row per (chat, unknown sender) while the admin card is pending; the UNIQUE constraint dedups repeat messages from the same sender. Cleared on approve / deny.

```sql
CREATE TABLE pending_sender_approvals (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity    TEXT NOT NULL,   -- namespaced user id (channel_type:handle)
  sender_name        TEXT,
  original_message   TEXT NOT NULL,   -- JSON serialized InboundEvent
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  options_json       TEXT NOT NULL DEFAULT '[]',
  UNIQUE(messaging_group_id, sender_identity)
);
CREATE INDEX idx_pending_sender_approvals_mg ON pending_sender_approvals(messaging_group_id);
```

Access layer: `src/modules/permissions/db/pending-sender-approvals.ts`; flow: `src/modules/permissions/sender-approval.ts`, `src/modules/permissions/index.ts`.

### 1.16 `pending_channel_approvals`

In-flight state for the unknown-channel registration flow: a chat that is not wired to any agent group mentions or DMs the bot, and the owner is asked whether to wire it. The primary key on `messaging_group_id` dedups repeat mentions while the card is pending. Approve creates the wiring and replays the event; deny sets `messaging_groups.denied_at`.

```sql
CREATE TABLE pending_channel_approvals (
  messaging_group_id TEXT PRIMARY KEY REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  original_message   TEXT NOT NULL,   -- JSON serialized InboundEvent
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  options_json       TEXT NOT NULL DEFAULT '[]'
);
```

Access layer: `src/modules/permissions/db/pending-channel-approvals.ts`; flow: `src/modules/permissions/channel-approval.ts`, `src/modules/permissions/index.ts`.

### 1.17 `container_configs`

Per-agent-group container runtime config. Source of truth for provider, model, packages, MCP servers, mounts, CLI scope, etc. Materialized to `groups/<folder>/container.json` at spawn time by `materializeContainerJson()` in `src/container-config.ts`.

```sql
CREATE TABLE container_configs (
  agent_group_id         TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
  provider               TEXT,
  model                  TEXT,
  effort                 TEXT,
  image_tag              TEXT,
  assistant_name         TEXT,
  max_messages_per_prompt INTEGER,
  skills                 TEXT NOT NULL DEFAULT '"all"',
  mcp_servers            TEXT NOT NULL DEFAULT '{}',
  packages_apt           TEXT NOT NULL DEFAULT '[]',
  packages_npm           TEXT NOT NULL DEFAULT '[]',
  additional_mounts      TEXT NOT NULL DEFAULT '[]',
  cli_scope              TEXT NOT NULL DEFAULT 'group',   -- disabled | group | global
  updated_at             TEXT NOT NULL
);
```

- **Readers:** `src/container-config.ts`, `src/container-runner.ts`, `src/cli/dispatch.ts` (scope enforcement), `src/claude-md-compose.ts`
- **Writers:** `src/db/container-configs.ts` (called from `src/group-init.ts`, `src/container-runner.ts`, and `ncl groups config ...` in `src/cli/resources/groups.ts`)

---

## 2. Migration system

Migrations live in `src/db/migrations/`, one file per migration, and are listed in order in the `migrations` array in `src/db/migrations/index.ts`. Runner: `runMigrations()` in the same file. It:

1. Creates `schema_version` (and its unique index on `name`) if absent.
2. Reads the set of already-applied migration `name`s.
3. For each migration in the array whose `name` is not recorded, executes `up(db)` inside a transaction and appends a `schema_version` row. The stored `version` is assigned at insert time (`MAX(version) + 1`), so it is an applied-order number, not the migration's own `version` field.

Applied state is keyed on `name`. Files prefixed `module-` hold the tables owned by a module (`src/modules/approvals/`, `src/modules/agent-to-agent/`); they live in the same directory and are registered in the same array.

In array order:

| Order | File | `name` | Introduces |
|-------|------|--------|------------|
| 1 | `001-initial.ts` | `initial-v2-schema` | Core tables: `agent_groups`, `messaging_groups`, `messaging_group_agents`, `users`, `user_roles`, `agent_group_members`, `user_dms`, `sessions`, `pending_questions` |
| 2 | `002-chat-sdk-state.ts` | `chat-sdk-state` | `chat_sdk_kv`, `chat_sdk_subscriptions`, `chat_sdk_locks`, `chat_sdk_lists` |
| 3 | `module-approvals-pending-approvals.ts` | `pending-approvals` | `pending_approvals` |
| 4 | `module-agent-to-agent-destinations.ts` | `agent-destinations` | `agent_destinations` + backfill from existing `messaging_group_agents` wirings |
| 5 | `module-approvals-title-options.ts` | `pending-approvals-title-options` | `ALTER TABLE pending_approvals` add `title`, `options_json` if missing (no-op on DBs that already have them) |
| 6 | `008-dropped-messages.ts` | `dropped-messages` | `unregistered_senders` |
| 7 | `009-drop-pending-credentials.ts` | `drop-pending-credentials` | Drops the `pending_credentials` table if present |
| 8 | `010-engage-modes.ts` | `engage-modes` | Adds `engage_mode`, `engage_pattern`, `sender_scope`, `ignored_message_policy` to `messaging_group_agents`, backfills them, drops `trigger_rules` and `response_scope` |
| 9 | `011-pending-sender-approvals.ts` | `pending-sender-approvals` | `pending_sender_approvals` |
| 10 | `012-channel-registration.ts` | `channel-registration` | `messaging_groups.denied_at`, `pending_channel_approvals` |
| 11 | `013-approval-render-metadata.ts` | `approval-render-metadata` | `title`, `options_json` on `pending_channel_approvals` and `pending_sender_approvals` |
| 12 | `014-container-configs.ts` | `container-configs` | `container_configs` — per-agent-group container runtime config |
| 13 | `015-cli-scope.ts` | `cli-scope` | `ALTER TABLE container_configs ADD COLUMN cli_scope` |

To add a migration, create a file in `src/db/migrations/` exporting a `Migration` with a unique `name`, and append it to the `migrations` array in `index.ts`.

Session DB schemas (`INBOUND_SCHEMA`, `OUTBOUND_SCHEMA`) are **not** versioned here. They're `CREATE TABLE IF NOT EXISTS` so new columns land via the session-DB lazy migration helpers (`migrateDeliveredTable()`, `migrateMessagesInTable()` in `src/db/session-db.ts`) when a session file from an older build is reopened. See [db-session.md](db-session.md).
