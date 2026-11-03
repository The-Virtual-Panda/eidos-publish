# Publish to Channels

A plugin for [Eidos MD](https://eidosmd.com) that publishes a blueprint or a top-level doc to a Microsoft Teams channel as one message. When the file changes, the next publish edits that message in place, and replies in its thread when the change is big enough. Slack comes in a later release.

It runs on your machine and talks to Microsoft directly, signed in as you. Nothing is hosted, and nothing is sent unless you ask.

```bash
eidos channels login teams
eidos channels connect team-updates --channel "<link from Get link to channel>"
eidos channels publish B-X05 --to team-updates --dry-run
eidos channels publish B-X05 --to team-updates
```

## Editing in place

Posting and replying need `ChannelMessage.Send`, which you can usually consent to yourself. Editing needs `ChannelMessage.ReadWrite`, which Microsoft requires an administrator to approve. `eidos channels login teams` asks for the first; `eidos channels login teams --edit` asks for both. Until editing is approved, a change posts a new message and the old one stays.

## Your organization's own app

An organization that will not consent to an outside app can register its own in Microsoft Entra ID (a public client, with public client flows allowed and the delegated permissions above) and set it, with no code change:

```bash
eidos plugin set channels client_id <application id>
eidos plugin set channels tenant <tenant id>
```

## Develop

```bash
pnpm install
pnpm test
pnpm build
```

The tests run against a fake Microsoft in `test/fake-microsoft.ts`, so they never reach a real tenant.
