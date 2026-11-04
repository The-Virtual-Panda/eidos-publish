// The Teams plugin's CLI entry: the core's commands and API over Microsoft Graph,
// and the sign-in, in the browser or with a device code. Built as a CommonJS bundle whose one import from the
// CLI is `eidosmd/plugin`.
import type { CliEntry, Host } from 'eidosmd/plugin';
import { action, print, publishApi, registerPublish, type PublishApi } from '../../../packages/core/src/commands.ts';
import { credentials } from '../../../packages/core/src/credentials.ts';
import { ProviderError } from '../../../packages/core/src/errors.ts';
import { destinations, type Account, type Provider } from '../../../packages/core/src/publish.ts';
import { teamsHtml } from './html.ts';
import { canEdit, DEFAULT_CLIENT_ID, graph, openInBrowser, permissionsFor, pollDeviceCode, readChannelLink, refresh, startBrowserSignIn, startDeviceCode, TEAMS_LIMIT_BYTES, type Channel, type Poll, type Sign } from './microsoft.ts';

interface TeamsSignIn {
  refresh_token: string;
  // the permissions Microsoft granted, by their short names
  scopes: string[];
  name: string;
  username: string;
  tenant: string;
  client_id: string;
}

export type LoginStart = { address: string; interval: number; expires_in: number } | { user_code: string; verification_uri: string; interval: number; expires_in: number };

export type LoginPoll = { state: 'pending' | 'slower' } | { state: 'done'; account: Account };

export interface TeamsApi extends PublishApi {
  loginStart(edit: boolean, device?: boolean): Promise<LoginStart>;
  loginPoll(): Promise<LoginPoll>;
}

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const entry: CliEntry = {
  register(host: Host) {
    const held = credentials<TeamsSignIn>('teams');
    const accountOf = (signIn: TeamsSignIn): Account => {
      const editing = canEdit(signIn.scopes);
      return { name: signIn.name || signIn.username, detail: editing ? 'can edit messages' : 'posts and replies only', can_edit: editing };
    };
    const clientId = (): string => {
      const id = String(host.settings().get<string>('client_id') ?? '').trim() || DEFAULT_CLIENT_ID;
      if (!id) throw new ProviderError("No Microsoft Entra app is set. Set your organization's with `eidos plugin set teams client_id <id>`.", null);
      return id;
    };
    const signFor = (permissions: string[], id: string): Sign => {
      const tenant = String(host.settings().get<string>('tenant') ?? '').trim();
      const known = destinations(host).find((destination) => destination['tenant'])?.['tenant'] as string | undefined;
      return { clientId: id, tenant: tenant || 'organizations', permissions, ...(tenant || !known ? {} : { consentTenant: known }) };
    };

    const provider: Provider = {
      command: 'teams',
      service: 'Teams',
      limit: TEAMS_LIMIT_BYTES,
      limitUnit: 'bytes',
      render: teamsHtml,
      renderReply: (lines) => `<p><strong>Updated</strong></p><ul>${lines.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>`,
      readChannel: (link) => {
        const read = readChannelLink(link);
        return { channel_name: read.channel_name, key: `${read.team}/${read.channel}`, team: read.team, channel: read.channel, tenant: read.tenant };
      },
      channelHelp: "the channel's link from Teams (Get link to channel)",
      account: () => {
        const signIn = held.get();
        return signIn ? accountOf(signIn) : null;
      },
      cannotEdit: 'Your sign-in cannot edit messages, so this posts a new one and the old one stays. Run `eidos teams login --edit` to edit in place; your administrator must approve it.',
      signIn: 'Sign in with `eidos teams login --edit` to send it.',
      postsAsPerson: true,
      sender: async () => {
        const signIn = held.get();
        if (!signIn) throw new ProviderError('You are not signed in to Teams. Run `eidos teams login`.', null);
        const id = clientId();
        if (signIn.client_id !== id) throw new ProviderError('This root now signs in with another Entra app. Run `eidos teams login` again.', null);
        const tokens = await refresh(signFor(signIn.scopes, id), signIn.refresh_token);
        if (tokens.refresh_token !== signIn.refresh_token) held.set({ ...signIn, refresh_token: tokens.refresh_token });
        const client = graph(tokens.access_token);
        const channel = (destination: { [field: string]: unknown }): Channel => ({ team: String(destination['team']), channel: String(destination['channel']) });
        return {
          post: (destination, message) => client.post(channel(destination), message),
          edit: (destination, id, message) => client.edit(channel(destination), id, message),
          reply: (destination, id, message) => client.reply(channel(destination), id, message),
        };
      },
      logout: () => held.drop(),
    };

    let pending: { sign: Sign; poll: () => Poll | Promise<Poll>; close: () => void } | null = null;
    const api: TeamsApi = {
      ...publishApi(host, provider),
      loginStart: async (edit, device = false) => {
        const sign = signFor(permissionsFor(edit), clientId());
        pending?.close();
        if (device) {
          const code = await startDeviceCode(sign);
          pending = { sign, poll: () => pollDeviceCode(sign, code.device_code), close: () => undefined };
          return { user_code: code.user_code, verification_uri: code.verification_uri, interval: code.interval, expires_in: code.expires_in };
        }
        const browser = await startBrowserSignIn(sign);
        pending = { sign, poll: browser.poll, close: browser.close };
        return { address: browser.address, interval: browser.interval, expires_in: browser.expires_in };
      },
      loginPoll: async () => {
        if (!pending) throw new ProviderError('No sign-in is under way.', null);
        const { sign } = pending;
        let poll;
        try {
          poll = await pending.poll();
        } catch (cause) {
          pending.close();
          pending = null;
          throw cause;
        }
        if (poll.state !== 'done') return { state: poll.state };
        pending = null;
        const { tokens } = poll;
        const signIn = { refresh_token: tokens.refresh_token, scopes: tokens.scopes, name: tokens.name, username: tokens.username, tenant: tokens.tenant, client_id: sign.clientId };
        held.set(signIn);
        host.emit('changed', {});
        return { state: 'done', account: accountOf(signIn) };
      },
    };

    host.command((command) => {
      command.description('Publish a blueprint or a top-level doc to a Microsoft Teams channel as one message, edited in place when the file changes');
      command
        .command('login')
        .option('--edit', 'also ask for permission to edit messages in place, which your administrator must approve')
        .option('--device', 'sign in with a code instead, for a machine with no browser; many organizations block this')
        .description('sign in to Microsoft in your browser; a message is posted as you')
        .action(
          action(async (options: { edit?: boolean; device?: boolean }) => {
            const start = await api.loginStart(options.edit === true, options.device === true);
            if ('address' in start) {
              print(`Opening your browser to sign in to Microsoft. If it does not open, go to ${start.address}`);
              openInBrowser(start.address);
            } else {
              print(`Go to ${start.verification_uri} and enter the code ${start.user_code}`);
            }
            let interval = start.interval;
            for (;;) {
              await new Promise((resolve) => setTimeout(resolve, interval * 1000));
              const poll = await api.loginPoll();
              if (poll.state === 'slower') interval += 5;
              if (poll.state !== 'done') continue;
              print(`Signed in as ${poll.account.name}. The sign-in is kept in ${held.where}.`);
              print(
                poll.account.can_edit
                  ? 'A change to a published file edits its message in place.'
                  : 'A change to a published file posts a new message. To edit in place instead, run `eidos teams login --edit`; your administrator must approve it.',
              );
              return;
            }
          }),
        );
    });
    registerPublish(host, provider, api);
    return { api };
  },
};

export default entry;
