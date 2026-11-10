## Publish to Slack

Publish to Slack is a plugin from outside the package (`@The-Virtual-Panda/slack`) that sends a blueprint or a top-level doc to a Slack channel as one message. The first publish posts it; a later publish edits it in place when the file changed, and replies in its thread when the change is big enough. It runs on the person's machine and talks to Slack directly, through an app the workspace makes for itself. A message is posted as that app.

### Sending is the person's call

Every post, edit, and reply reaches real people. Never publish on your own initiative. Run `eidos slack publish <file> --to <destination> --dry-run`, show the person what would be sent and the decision, and publish only once they agree. A dry run needs no sign-in and sends nothing.

### Files

- `.eidos/plugins/slack/settings.yaml`: `destinations` (shared), each `{ name, channel_name, key, channel }`, where `channel_name` is the channel's name in Slack, looked up when it is added and empty when Slack would not say; `reply` and `reply_min_chars`. Change destinations with `connect` and `disconnect`, never by editing the file.
- `.eidos/plugins/slack/published.yaml`: per file (a blueprint's id, a top-level doc's path) and destination, the message and a digest and compressed text of what was last sent. Shared, written by the plugin alone; never edit it.
- The bot token is in `plugins/slack/credentials.json` in the Eidos app data folder, readable only by its owner, never in the root. Never read it or print it. It holds one workspace's token per machine.

### Commands

- `eidos slack login`: keeps the bot token, typed hidden (read from stdin without a terminal, never an argument), checked with Slack first. In a terminal it prints the address that makes the app from the plugin's manifest, which asks for `chat:write` and `chat:write.public` to post, edit, and reply, and `channels:read` and `groups:read` to read a channel's name. The person must do this themselves. `eidos slack manifest` prints the manifest.
- `eidos slack logout`, `eidos slack whoami [--json]`.
- `eidos slack connect [name] --channel <link or id> [--json]`: add a destination by Copy link in Slack, or the channel's id. Signed in, it reads the channel's name from Slack and is named from it unless a name is given. Signed out, or with an app made before the plugin read names, or a private channel the app is not in, it is added as `slack-channel` (then `slack-channel-2`, and so on) and says so; give a name to choose one. `eidos slack disconnect <name>` removes one; its messages stay. `eidos slack destinations [--json]` lists them. A private channel needs the app invited with `/invite`.
- `eidos slack publish <file> --to <destination> [--dry-run] [--force] [--no-reply] [--property <name>...] [--json]`: `<file>` is a blueprint's id or path, or a top-level doc's path. `--force` edits a message whose file did not change, for after a release that changes rendering. `--dry-run --json`: `{ file, title, destination, action: post|edit|none|refused, reason, message, size, limit, reply, reply_offered?, url, dry_run }`. `--json`: `{ file, destination, outcome: posted|edited|replaced|unchanged, reason, message_id, url, replied, reply_error? }`.
- `eidos slack status [<destination>] [--json]`: read from the root alone, with no request: `[{ file, destination, state: current|changed|missing, at, by, url }]`.

### What a publish does

- Nothing recorded: posts and records it. The same as last sent: sends nothing. Different: edits in place. Every publish through the same app can edit the message, whoever sent it first.
- An edit replies with the sections added, removed, and changed, and the list items added, removed, and edited under them, when the characters added and removed reach `reply_min_chars` or a heading or an item was added or removed. A smaller edit replies only when a person chooses to in the publish dialog.
- The message gone: a new one replaces it. A refusal (the app not in the channel, the token revoked): fails and posts nothing. Throttled or unavailable: fails and changes nothing.
- A message over 12,000 characters is refused before anything is sent.
- An edit made in Slack is overwritten by the next publish. A file removed from the root leaves its message in place.

### Shared properties

On a first post a person chooses which frontmatter properties to share at the top of the message, in the Publish dialog or with `--property`. The channel remembers the last properties chosen, and a shared property stays on that message's later edits. Replies name the list items and properties that changed. Slack messages mention nobody.

### Automations

The step **Publish to Slack** (`slack.publish`) publishes the file that started the run, or a named one, to a channel, with the channel's remembered properties. The first run to reach it asks, since it leaves this machine.
