// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// `cli` (the local-terminal channel) and `telegram` (active only when
// TELEGRAM_BOT_TOKEN is set) are wired by default. To add a channel, write
// `src/channels/<name>.ts` and append its import below; see
// docs/writing-a-channel.md.

import './cli.js';
import './telegram.js'; // Telegram (polling): enabled when TELEGRAM_BOT_TOKEN is set in .env
// import './slack.js'; // Slack (Socket Mode): uncomment and set SLACK_BOT_TOKEN + SLACK_APP_TOKEN
