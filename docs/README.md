# NanoMika documentation

Start with the [README](../README.md) for setup and everyday use.

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | The full architecture: host, containers, routing, sessions, delivery |
| [architecture-diagram.md](architecture-diagram.md) | The same as diagrams ([HTML version](architecture-diagram.html)) |
| [writing-a-channel.md](writing-a-channel.md) | Adding your own channel, with a complete example |
| [isolation-model.md](isolation-model.md) | Sharing or separating agents and sessions across chats |
| [SECURITY.md](SECURITY.md) | What is protected, how, and what is not |
| [db.md](db.md) | Overview of the three databases and who writes what |
| [db-central.md](db-central.md) | Every table of the central database, and the migrations |
| [db-session.md](db-session.md) | The per-session `inbound.db` and `outbound.db` |
| [api-details.md](api-details.md) | Host interfaces: channel adapter, delivery, routing |
| [agent-runner-details.md](agent-runner-details.md) | The code inside the container and its MCP tools |
| [build-and-runtime.md](build-and-runtime.md) | Node host and Bun container, lockfiles, image build, CI |
| [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md) | Notes on the internals of the Claude Agent SDK |
