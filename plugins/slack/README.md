# Publish to Slack

A plugin for [Eidos MD](https://eidosmd.com) that publishes a blueprint or a top-level doc to a Slack channel as one message. When the file changes, the next publish edits that message in place, and replies in its thread when the change is big enough.

It runs on your machine and talks to Slack directly. Nothing is hosted, and nothing is sent unless you ask.

```bash
eidos plugin install @The-Virtual-Panda/slack
```

Install from the Registry, not from this repository.

## Use it

```bash
eidos slack login
eidos slack connect team-updates --channel "<link from Copy link>"
eidos slack publish B-X05 --to team-updates --dry-run
eidos slack publish B-X05 --to team-updates
```

A message is posted as an app your workspace makes for itself. `eidos slack login` prints the address that creates it with everything filled in, asking only for `chat:write` and `chat:write.public`. Install it, then paste its Bot User OAuth Token. Invite the app to a private channel with `/invite`. A message can be up to 12,000 characters.
