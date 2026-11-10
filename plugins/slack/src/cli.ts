// The Slack plugin's CLI entry: the core's commands and API over Slack's Web API,
// and signing in with the bot token of an app the workspace makes from the manifest
// shipped here. Built as a CommonJS bundle whose one import from the CLI is
// `eidosmd/plugin`.
import type { CliEntry, Host } from 'eidosmd/plugin';
import { action, automationSteps, print, publishApi, registerPublish, type PublishApi } from '../../../packages/core/src/commands.ts';
import { credentials } from '../../../packages/core/src/credentials.ts';
import { ProviderError } from '../../../packages/core/src/errors.ts';
import { ask, readLines } from '../../../packages/core/src/prompt.ts';
import type { Account, Provider } from '../../../packages/core/src/publish.ts';
import { slackMarkdown, slackReply } from './markdown.ts';
import { APP_MANIFEST, createAppAddress, readChannel, SLACK_LIMIT_CHARACTERS, slackClient } from './slack.ts';

interface SlackSignIn {
  token: string;
  team: string;
  bot: string;
}

export interface SlackApi extends PublishApi {
  // checked against Slack before it is kept (REQ14); the answer never carries it
  login(token: string): Promise<Account>;
  createAppAddress(): string;
}

const entry: CliEntry = {
  register(host: Host) {
    const held = credentials<SlackSignIn>('slack');
    const accountOf = (signIn: SlackSignIn): Account => ({ name: signIn.team, detail: `posts as ${signIn.bot}`, can_edit: true });
    const provider: Provider = {
      command: 'slack',
      service: 'Slack',
      limit: SLACK_LIMIT_CHARACTERS,
      limitUnit: 'characters',
      render: slackMarkdown,
      renderReply: slackReply,
      readChannel: (link) => {
        const channel = readChannel(link);
        return { channel_name: '', key: channel, channel };
      },
      channelHelp: "the channel's link from Slack (Copy link), or its id",
      // signed out, a channel is added by its link alone and named after the service
      channelName: async (read) => {
        const signIn = held.get();
        return signIn ? slackClient(signIn.token).channelName(String(read['channel'])) : '';
      },
      account: () => {
        const signIn = held.get();
        return signIn ? accountOf(signIn) : null;
      },
      cannotEdit: '',
      signIn: 'Sign in with `eidos slack login` to send it.',
      postsAsPerson: false,
      sender: async () => {
        const signIn = held.get();
        if (!signIn) throw new ProviderError('You are not signed in to Slack. Run `eidos slack login`.', null);
        const client = slackClient(signIn.token);
        return {
          post: (destination, message) => client.post(String(destination['channel']), message),
          edit: (destination, id, message) => client.edit(String(destination['channel']), id, message),
          reply: (destination, id, message) => client.reply(String(destination['channel']), id, message),
        };
      },
      logout: () => held.drop(),
    };

    const api: SlackApi = {
      ...publishApi(host, provider),
      login: async (token) => {
        const given = token.trim();
        if (!given.startsWith('xoxb-')) throw new ProviderError("That is not a bot token. Use the app's Bot User OAuth Token, which starts with xoxb-.", null);
        const who = await slackClient(given).whoAmI();
        const signIn = { token: given, team: who.team, bot: who.bot };
        held.set(signIn);
        host.emit('changed', {});
        return accountOf(signIn);
      },
      createAppAddress,
    };

    host.command((command) => {
      command.description('Publish a blueprint or a top-level doc to a Slack channel as one message, edited in place when the file changes');
      command
        .command('login')
        .description('keep the bot token of your Slack app, typed hidden and checked against Slack first')
        .action(
          action(async () => {
            let token: string;
            if (process.stdin.isTTY) {
              print(`If your workspace has no app yet, make one from the plugin's manifest and install it:\n${createAppAddress()}\nThen copy its Bot User OAuth Token from OAuth & Permissions.`);
              token = await ask('Bot token: ', true);
            } else {
              token = (await readLines(1))[0] ?? '';
            }
            const account = await api.login(token);
            print(`Signed in to ${account.name}, ${account.detail}. The token is kept in ${held.where}.`);
          }),
        );
      command
        .command('manifest')
        .description('print the Slack app manifest, to make the app by hand')
        .action(
          action(() => {
            print(JSON.stringify(APP_MANIFEST, null, 2));
          }),
        );
    });
    registerPublish(host, provider, api);
    return { api: { ...api, automations: automationSteps(provider, api) } };
  },
};

export default entry;
