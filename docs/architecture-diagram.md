# NanoMika Architecture Diagram

## System Overview

```mermaid
flowchart TB
  subgraph Platforms["Channels"]
    P1["Local CLI<br/>(src/channels/cli.ts, default)"]
    P2["Slack<br/>(src/channels/slack.ts, opt-in)"]
    P3["Channels you write<br/>(docs/writing-a-channel.md)"]
  end

  subgraph Host["Host Process (Node)"]
    direction TB
    Bridge["Channel Adapters<br/>(src/channels/: native, or Chat SDK bridge<br/>src/channels/chat-sdk-bridge.ts)"]
    Router["Router<br/>(src/router.ts)<br/>platformId + threadId -> messaging_group -> agent_group -> session"]
    SessMgr["Session Manager<br/>(src/session-manager.ts)<br/>creates inbound.db + outbound.db"]
    Runner["Container Runner<br/>(src/container-runner.ts)<br/>docker run"]
    Delivery["Delivery Poller<br/>(src/delivery.ts)<br/>1s active / 60s sweep"]
    Sweep["Host Sweep<br/>(src/host-sweep.ts)<br/>heartbeat, retry, recurrence"]
    Central[("Central DB<br/>data/v2.db<br/>agent_groups<br/>messaging_groups<br/>messaging_group_agents<br/>sessions<br/>pending_approvals")]
    Approvals["Approvals module<br/>(src/modules/approvals/)<br/>requestApproval -> pending_approvals"]
    Proxy["Credential Proxy<br/>(src/credential-proxy.ts, :3001)<br/>injects real key from .env"]
  end

  Anthropic["Anthropic API"]

  subgraph Session["Per-Session Container (Docker)"]
    direction TB
    PollLoop["Poll Loop<br/>(container/agent-runner)"]
    Provider["Agent providers<br/>(claude, mock)"]
    MCP["MCP Tools<br/>send_message, send_file, edit_message,<br/>add_reaction, send_card, ask_user_question,<br/>schedule_task (+ list/update/pause/resume/cancel),<br/>create_agent"]
    Skills["Container Skills<br/>(container/skills/)"]
    InDB[("inbound.db<br/>host writes<br/>even seq<br/>messages_in<br/>delivered<br/>destinations")]
    OutDB[("outbound.db<br/>container writes<br/>odd seq<br/>messages_out<br/>processing_ack")]
  end

  subgraph Groups["Agent Group Filesystem (groups/*)"]
    Folder["CLAUDE.md<br/>CLAUDE.local.md (memory)<br/>container.json"]
  end

  P1 & P2 & P3 --> Bridge
  Bridge --> Router
  Router --> Central
  Router --> SessMgr
  SessMgr --> InDB
  SessMgr --> Runner
  Runner --> PollLoop
  PollLoop --> InDB
  PollLoop --> Provider
  Provider --> MCP
  Provider --> Skills
  MCP --> OutDB
  OutDB --> Delivery
  Delivery --> Central
  Delivery --> Bridge
  Bridge --> P1 & P2 & P3
  Sweep --> InDB
  Sweep --> OutDB
  Sweep --> Central
  Runner -.mounts.-> Folder
  Delivery -.approval-gated ncl.-> Approvals
  Approvals --> Central
  Provider -.API calls.-> Proxy
  Proxy --> Anthropic
```

## Message Flow (inbound -> agent -> outbound)

```mermaid
sequenceDiagram
  participant P as Platform (e.g. CLI terminal)
  participant B as Channel Adapter
  participant R as Router
  participant SM as Session Manager
  participant IDB as inbound.db
  participant C as Container (agent-runner)
  participant ODB as outbound.db
  participant D as Delivery Poller

  P->>B: new message
  B->>R: routeInbound(event)
  R->>R: resolve messaging_group -> agent_group -> session<br/>(agent-shared | shared | per-thread)
  R->>SM: ensure session + DBs exist
  R->>IDB: INSERT messages_in (even seq)
  R->>C: wake container (docker run / already running)
  C->>IDB: poll messages_in
  C->>C: format xml, stream to selected provider
  C->>ODB: INSERT messages_out (odd seq)<br/>parse <message to="name"> blocks
  D->>ODB: 1s poll (active) / 60s (sweep)
  D->>D: re-validate against agent_destinations
  D->>B: deliver via adapter
  B->>P: send message / edit / react / file / card
```

## Named Destinations + Agent-to-Agent

```mermaid
flowchart LR
  subgraph AgentA["Agent Group A (main)"]
    A_out["output:<br/>&lt;message to='slack'&gt;...&lt;/message&gt;<br/>&lt;message to='browser-agent'&gt;...&lt;/message&gt;<br/>&lt;internal&gt;scratchpad&lt;/internal&gt;"]
  end

  subgraph Dests["inbound.db.destinations (from agent_destinations)"]
    D1["slack -> Slack messaging group"]
    D2["browser-agent -> agent group<br/>(bidirectional row)"]
    D3["cli -> cli/local messaging group"]
  end

  subgraph AgentB["Agent Group B (browser sub-agent)"]
    B_session["own inbound.db / outbound.db<br/>inherited destination back to A"]
  end

  Slack[Slack channel]
  CLI[Local CLI terminal]

  A_out -->|parse + lookup| Dests
  D1 -->|deliver| Slack
  D2 -->|write to B's inbound.db| B_session
  D3 -->|deliver| CLI
  B_session -.reply via 'parent'.-> Dests
```

## Entity Model + Isolation Levels

```mermaid
erDiagram
  agent_groups ||--o{ messaging_group_agents : wired
  messaging_groups ||--o{ messaging_group_agents : wired
  agent_groups ||--o{ sessions : runs
  messaging_groups ||--o{ sessions : context
  agent_groups ||--o{ agent_destinations : owns
  agent_groups ||--o{ pending_approvals : requests

  agent_groups {
    string id
    string name
    string folder
    string agent_provider
  }
  messaging_groups {
    string id
    string channel_type
    string platform_id
    string name
    bool is_group
    string unknown_sender_policy "strict | request_approval | public"
  }
  users {
    string id PK "namespaced <channel>:<handle>"
    string kind
    string display_name
  }
  user_roles {
    string user_id FK
    string role "owner | admin"
    string agent_group_id FK "null = global"
  }
  agent_group_members {
    string user_id FK
    string agent_group_id FK
  }
  user_dms {
    string user_id FK
    string channel_type
    string messaging_group_id FK
  }
  messaging_group_agents {
    string messaging_group_id
    string agent_group_id
    string session_mode "agent-shared | shared | per-thread"
    string engage_mode "pattern | mention | mention-sticky"
    string engage_pattern
    string sender_scope "all | known"
    string ignored_message_policy "drop | accumulate"
    int priority
  }
  sessions {
    string id
    string agent_group_id
    string messaging_group_id
    string thread_id
    string status
    string container_status
  }
```

### Isolation Level Cheatsheet

| Level | `session_mode` | What's shared | Example |
|---|---|---|---|
| 1. Shared session | `agent-shared` | Workspace + memory + conversation | CLI + a Slack channel in one conversation |
| 2. Same agent, separate sessions | `shared` / `per-thread` | Workspace + memory only | One agent across 3 Slack channels |
| 3. Separate agent groups | (different `agent_group_id`) | Nothing | Personal vs work channels |

## Two-DB Split (why)

```mermaid
flowchart LR
  subgraph Mount["/workspace (volume mounted into container)"]
    In[("inbound.db")]
    Out[("outbound.db")]
    HB["/.heartbeat (file touch)"]
  end

  Host[Host process] -->|"writes only<br/>(even seq)"| In
  Host -->|reads| Out
  Container[agent-runner] -->|reads| In
  Container -->|"writes only<br/>(odd seq)"| Out
  Container -->|touch on agent activity| HB
  HostSweep[Host sweep] -->|stat mtime| HB
  HostSweep -->|reads processing_ack| Out

  note1["Each file has exactly ONE writer.<br/>Eliminates SQLite cross-process write contention.<br/>Collision-free seq numbering."]
```
