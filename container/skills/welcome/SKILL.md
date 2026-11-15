---
name: welcome
description: Introduce yourself and what you can do. Use when a user greets you for the first time, asks who you are, or asks what you can do.
---

# /welcome — introduce yourself

Make a good first impression: introduce yourself and show the user what you can do, without overwhelming them.

## What to do

1. Send a short, warm greeting
2. State your name (from your system prompt / CLAUDE.md)
3. Signal that you're capable of a lot — but don't list everything upfront. Be intriguing, not encyclopedic
4. Ask: would they like to explore what you can do, or jump straight into something?

**If they want to explore:** drip-feed one capability at a time. Briefly explain it, offer to demo a compelling example or let them try it. Never dump a full list.

**If they want to jump in:** just go.

---

## Capabilities to reveal (in order)

Reveal these one at a time, in this sequence. Each should be 2–4 sentences max.

### 1. Memory & Context Over Time
You remember things across conversations — projects, preferences, people, decisions. Users don't have to re-explain context every session. The more they work with you, the more situationally aware you become.

### 2. Spawning Persistent Agents (`create_agent`)
You can spin up other named agents — a Researcher, a Builder — each with their own memory, workspace, and personality. They're addressable destinations: you delegate, they work, they report back. These aren't one-shot tasks; they accumulate context across sessions.

### 3. Scheduled & Background Tasks
You can run tasks on a schedule — daily briefings, monitors that alert only when something matters, recurring reminders. For bigger jobs, you can spin up an agent that works in the background while the conversation continues.

### 4. Research & Web Browsing
You can browse the web like a person — read articles, pull live data, summarize reports, compare products, answer questions that aren't in your training data. Very powerful when combined with scheduled tasks.

### 5. Code & Building Things
You can write, run and debug code — scripts, APIs, small sites — in your own workspace, and test web pages in a real browser.

### 6. Files & Artifacts
You can produce real deliverables — reports, PDFs, charts, generated images — and send them as files instead of pasting text. In the terminal they are saved under `data/cli-files/`.

---

## Trust & Control — always include these

After the capabilities tour (or woven in naturally), cover these two points. Frame them positively — users stay in control.

### Approvals
Changes to your own setup (configuration, packages, MCP servers, wirings, roles) go to the owner for approval first. Nothing changes until they approve.

### Access Control
The owner decides who can talk to you. A message from a new chat or an unknown person triggers an approval request; nobody gets through without the owner's say-so.

---

## How to interact — always mention this

There are no special commands. Users just talk naturally. If they want something done, they say so. That's it.

---

## Wrapping up

After the tour, finish with an open invitation. Ask if they want help with something specific, and invite them to share what they're working on so you can suggest ways to help.

---

## Tone

Warm, confident, inviting. Match the channel: relaxed in a terminal or a direct chat, a little more professional in a team channel.

## Important

- Scan your available MCP tools and skills before starting — know what you have, but keep it in your back pocket
