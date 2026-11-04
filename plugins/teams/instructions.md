## Publish to Microsoft Teams

Publish to Microsoft Teams is a plugin from outside the package (`@The-Virtual-Panda/teams`) that sends a blueprint or a top-level doc to a Teams channel as one message. The first publish posts it; a later publish edits it in place when the file changed, and replies in its thread when the change is big enough. It runs on the person's machine and talks to Microsoft directly, signed in as the person.

### Sending is the person's call

Every post, edit, and reply reaches real people, under the person's name. Never publish on your own initiative. Run `eidos teams publish <file> --to <destination> --dry-run`, show the person what would be sent and the decision, and publish only once they agree. A dry run needs no sign-in and sends nothing.

### Files

- `.eidos/plugins/teams/settings.yaml`: `destinations` (shared), each `{ name, channel_name, key, team, channel, tenant }`; `reply` and `reply_min_chars`. Change destinations with `connect` and `disconnect`, never by editing the file.
- `.eidos/plugins/teams/local.yaml`: `client_id` and `tenant`, an organization's own Entra app in place of The Virtual Panda's.
- `.eidos/plugins/teams/published.yaml`: per file (a blueprint's id, a top-level doc's path) and destination, the message and a digest and compressed text of what was last sent. Shared, written by the plugin alone; never edit it.
- The sign-in is in `plugins/teams/credentials.json` in the Eidos app data folder, readable only by its owner, never in the root. Never read it or print it.

### Commands

- `eidos teams login [--edit] [--device]`: sign in with Microsoft in the browser, or with `--device` a code entered on another machine, for a machine with no browser (security defaults and many organizations block it). Plain, it asks for `ChannelMessage.Send`: posts and replies, with no administrator where the organization allows a person's consent. `--edit` also asks for `ChannelMessage.ReadWrite`, which an administrator must approve, and turns on editing in place. A sign-in the organization refuses prints the address to hand the administrator. The person must do this themselves.
- `eidos teams logout`, `eidos teams whoami [--json]`.
- `eidos teams connect <name> --channel <link> [--json]`: add a destination by the link from Teams (Get link to channel). `eidos teams disconnect <name>` removes one; its messages stay. `eidos teams destinations [--json]` lists them.
- `eidos teams publish <file> --to <destination> [--dry-run] [--force] [--no-reply] [--take-over] [--json]`: `<file>` is a blueprint's id or path, or a top-level doc's path. `--force` edits a message whose file did not change, for after a release that changes rendering. `--dry-run --json`: `{ file, title, destination, action: post|edit|repost|none|refused, reason, message, size, limit, reply, url, dry_run }`. `--json`: `{ file, destination, outcome: posted|edited|reposted|replaced|unchanged, reason, message_id, url, replied, reply_error? }`.
- `eidos teams status [<destination>] [--json]`: read from the root alone, with no request: `[{ file, destination, state: current|changed|missing, at, by, url }]`.

### What a publish does

- Nothing recorded: posts and records it. The same as last sent: sends nothing. Different: edits in place, or, signed in without `--edit`, posts a new message recorded in place of the old one, which stays.
- An edit replies with the sections added, removed, and changed when the characters added and removed reach `reply_min_chars` or a heading was added or removed.
- A message another person posted: only its author can edit it, so sending posts a second message and theirs stays. A person is warned, told who posted it, and asked to confirm; the plan carries `posted_by_other`. With no terminal it fails unless `--take-over` says to post it. Show the person the warning and let them decide: asking the author to publish again keeps it as one message.
- The message gone (404, 410): a new one replaces it. A 403: fails and posts nothing, since the person lost access or the message is someone else's. Throttled or unavailable: fails and changes nothing.
- A message over 28,000 bytes is refused before anything is sent.
- An edit made in Teams is overwritten by the next publish. A file removed from the root leaves its message in place.
