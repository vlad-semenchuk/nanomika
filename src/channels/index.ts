// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Only `cli` (the local-terminal channel) is wired by default. To add a
// channel, write `src/channels/<name>.ts` and append its import below; see
// docs/writing-a-channel.md.

import './cli.js';
// import './slack.js'; // Slack (Socket Mode): uncomment and set SLACK_BOT_TOKEN + SLACK_APP_TOKEN
