# Eidos Publish

Two plugins for [Eidos MD](https://eidosmd.com) that publish a blueprint or a top-level doc to a chat channel as one message. When the file changes, the next publish edits that message in place, and replies in its thread when the change is big enough. Install the one for the service your team uses.

| Plugin                     | Install                    | Commands          |
| -------------------------- | -------------------------- | ----------------- |
| Publish to Microsoft Teams | `@The-Virtual-Panda/teams` | `eidos teams ...` |
| Publish to Slack           | `@The-Virtual-Panda/slack` | `eidos slack ...` |

Each runs on your machine and talks to the service directly. Nothing is hosted, and nothing is sent unless you ask. Install from the Registry, not from this repository, because its latest release may be either plugin.

## Publish to Microsoft Teams

```bash
eidos teams login
eidos teams connect team-updates --channel "<link from Get link to channel>"
eidos teams publish B-X05 --to team-updates --dry-run
eidos teams publish B-X05 --to team-updates
```

A message is posted as you. Posting and replying need `ChannelMessage.Send`, which you can usually consent to yourself. Editing needs `ChannelMessage.ReadWrite`, which Microsoft requires an administrator to approve. `eidos teams login` asks for the first; `eidos teams login --edit` asks for both. Until editing is approved, a change posts a new message and the old one stays.

Only the person who posted a message can edit it, so when someone else's file changes they publish it again. If you publish a message another person posted, the plugin warns you who posted it and asks before posting a second message under your name; theirs stays. In a script, `--take-over` says yes.

`eidos teams login` opens Microsoft's sign-in in your browser. On a machine with no browser, `eidos teams login --device` signs in with a code you enter elsewhere, which security defaults and many organizations block.

An organization that will not consent to an outside app can register its own in Microsoft Entra ID (a public client, with public client flows allowed, `http://localhost` as a Mobile and desktop redirect URI, and the delegated permissions above) and set it, with no code change:

```bash
eidos plugin set teams client_id <application id>
eidos plugin set teams tenant <tenant id>
```

## Publish to Slack

```bash
eidos slack login
eidos slack connect team-updates --channel "<link from Copy link>"
eidos slack publish B-X05 --to team-updates --dry-run
eidos slack publish B-X05 --to team-updates
```

A message is posted as an app your workspace makes for itself. `eidos slack login` prints the address that creates it with everything filled in, asking only for `chat:write` and `chat:write.public`. Install it, then paste its Bot User OAuth Token. Invite the app to a private channel with `/invite`. A message can be up to 12,000 characters.

## Develop

```bash
pnpm install
pnpm test
pnpm build
```

The code the plugins share is in `packages/core`, bundled into each plugin's own build in `plugins/<name>/dist`. The tests run against fake services, so they never reach a real tenant or workspace.

## Release

Each plugin has its own version in `plugins/<name>/manifest.yaml`, and its own tag and GitHub release, named `teams-v0.1.0` or `slack-v0.1.0`. A tag has no slash, because the Registry reads a README by the tag whole. Browse in Eidos MD searches a plugin's title, name, description, and its listing's keywords, and the keywords live only in the Registry listing, so give them when a plugin is first listed:

```bash
eidos publish --plugin plugins/teams/dist --ref teams-v0.1.0 --keywords "publish,teams,microsoft-teams,channel,chat,message,post,share,announce"
eidos publish --plugin plugins/slack/dist --ref slack-v0.1.0 --keywords "publish,slack,channel,chat,message,post,share,announce"
```
