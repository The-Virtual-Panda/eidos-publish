# Eidos Publish

Plugins for [Eidos MD](https://eidosmd.com) that publish a blueprint or a top-level doc to a chat channel as one message. When the file changes, the next publish edits that message in place, and replies in its thread when the change is big enough. Each plugin runs on your machine and talks to the service directly. Nothing is hosted, and nothing is sent unless you ask.

Each plugin has its own page with how to install and use it:

- [Publish to Microsoft Teams](plugins/teams/README.md)
- [Publish to Slack](plugins/slack/README.md)

## Develop

```bash
pnpm install
pnpm test
pnpm build
```

The code the plugins share is in `packages/core`, bundled into each plugin's own build in `plugins/<name>/dist`. The tests run against fake services, so they never reach a real tenant or workspace.

## Release

Each plugin has its own version in `plugins/<name>/manifest.yaml`, and its own tag and GitHub release, named `teams-v0.1.0` or `slack-v0.1.0`. A tag has no slash, because the Registry reads a README by the tag whole.

Each release carries the plugin's own `README.md` with its other files, built into `plugins/<name>/dist`, and that is the page Browse in Eidos MD shows. Attach it to the GitHub release, and write its links in full, since a release file has no folder to be relative to. A release without one, or an Eidos MD from before this, shows this file at the tag instead, so this file stays about the repository.

Browse in Eidos MD searches a plugin's title, name, description, and its listing's keywords, and the keywords live only in the Registry listing, so give them when a plugin is first listed:

```bash
eidos publish --plugin plugins/teams/dist --ref teams-v0.1.0 --keywords "publish,teams,microsoft-teams,channel,chat,message,post,share,announce"
eidos publish --plugin plugins/slack/dist --ref slack-v0.1.0 --keywords "publish,slack,channel,chat,message,post,share,announce"
```
