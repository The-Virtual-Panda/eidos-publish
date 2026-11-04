## Publish to Slack

Publish to Slack is a plugin from outside the package (`@The-Virtual-Panda/slack`) that sends a blueprint or a top-level doc to a Slack channel as one message. The first publish posts it; a later publish edits it in place when the file changed, and replies in its thread when the change is big enough. It runs on the person's machine and talks to Slack directly, through an app the workspace makes for itself. A message is posted as that app.

### Sending is the person's call

Every post, edit, and reply reaches real people. Never publish on your own initiative. Run `eidos slack publish <file> --to <destination> --dry-run`, show the person what would be sent and the decision, and publish only once they agree. A dry run needs no sign-in and sends nothing.

### Files

- `.eidos/plugins/slack/settings.yaml`: `destinations` (shared), each `{ name, channel_name, key, channel }`; `reply` and `reply_min_chars`. Change destinations with `connect` and `disconnect`, never by editing the file.
- `.eidos/plugins/slack/published.yaml`: per file (a blueprint's id, a top-level doc's path) and destination, the message and a digest and compressed text of what was last sent. Shared, written by the plugin alone; never edit it.
- The bot token is in `plugins/slack/credentials.json` in the Eidos app data folder, readable only by its owner, never in the root. Never read it or print it. It holds one workspace's token per machine.

### Commands

- `eidos slack login`: keeps the bot token, typed hidden (read from stdin without a terminal, never an argument), checked with Slack first. In a terminal it prints the address that makes the app from the plugin's manifest. The person must do this themselves. `eidos slack manifest` prints the manifest.
- `eidos slack logout`, `eidos slack whoami [--json]`.
- `eidos slack connect [name] --channel <link or id> [--json]`: add a destination by Copy link in Slack, or the channel's id. `eidos slack disconnect <name>` removes one; its messages stay. `eidos slack destinations [--json]` lists them. A private channel needs the app invited with `/invite`.
- `eidos slack publish <file> --to <destination> [--dry-run] [--force] [--no-reply] [--json]`: `<file>` is a blueprint's id or path, or a top-level doc's path. `--force` edits a message whose file did not change, for after a release that changes rendering. `--dry-run --json`: `{ file, title, destination, action: post|edit|none|refused, reason, message, size, limit, reply, url, dry_run }`. `--json`: `{ file, destination, outcome: posted|edited|replaced|unchanged, reason, message_id, url, replied, reply_error? }`.
- `eidos slack status [<destination>] [--json]`: read from the root alone, with no request: `[{ file, destination, state: current|changed|missing, at, by, url }]`.

### What a publish does

- Nothing recorded: posts and records it. The same as last sent: sends nothing. Different: edits in place.
- An edit replies with the sections added, removed, and changed when the characters added and removed reach `reply_min_chars` or a heading was added or removed.
- The message gone: a new one replaces it. A refusal (the app not in the channel, the token revoked): fails and posts nothing. Throttled or unavailable: fails and changes nothing.
- A message over 12,000 characters is refused before anything is sent.
- An edit made in Slack is overwritten by the next publish. A file removed from the root leaves its message in place.
