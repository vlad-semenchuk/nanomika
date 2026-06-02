---
name: setup
description: Run initial NanoMika setup. Use when user wants to install NanoMika, configure it, or go through first-time setup. Triggers on "setup", "install", "configure nanomika", or first-time setup requests.
---

# NanoMika Setup

Tell the user to run `bash nanomika.sh` in their terminal. That script handles the full end-to-end setup — dependencies, container image, OneCLI vault, Anthropic credential, service, first agent, and optional channel wiring.

If they hit an error partway through, it will offer Claude-assisted recovery inline — no need to come back here.
