# Publish to Microsoft Teams

A plugin for [Eidos MD](https://eidosmd.com) that publishes a blueprint or a top-level doc to a Microsoft Teams channel as one message. When the file changes, the next publish edits that message in place, and replies in its thread when the change is big enough.

It runs on your machine and talks to Microsoft directly. Nothing is hosted, and nothing is sent unless you ask.

```bash
eidos plugin install @The-Virtual-Panda/teams
```

Install from the Registry, not from this repository.

## Use it

```bash
eidos teams login
eidos teams connect --channel "<link from Get link to channel>"
eidos teams publish B-X05 --to general --dry-run
eidos teams publish B-X05 --to general
```

A message is posted as you. Posting and replying need `ChannelMessage.Send`, which you can usually consent to yourself. Editing needs `ChannelMessage.ReadWrite`, which Microsoft requires an administrator to approve. `eidos teams login` asks for the first; `eidos teams login --edit` asks for both. A sign-in also asks for `Team.ReadBasic.All`, so a channel shows as Engineering / General rather than just General; if you signed in before this, sign in again to see team names. Until editing is approved, a change posts a new message and the old one stays.

Only the person who posted a message can edit it, so when someone else's file changes they publish it again. If you publish a message another person posted, the plugin warns you who posted it and asks before posting a second message under your name; theirs stays. In a script, `--take-over` says yes.

`eidos teams login` opens Microsoft's sign-in in your browser. On a machine with no browser, `eidos teams login --device` signs in with a code you enter elsewhere, which security defaults and many organizations block.
