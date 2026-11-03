// The plugin's CLI entry: `eidos channels` and its commands, and the API the
// app's half answers the page through. Built as a CommonJS bundle whose one
// import from the CLI is `eidosmd/plugin`.
import type { CliEntry, Host } from 'eidosmd/plugin';
import { canEdit, DEFAULT_CLIENT_ID, permissionsFor, pollDeviceCode, ProviderError, readChannelLink, startDeviceCode, type Sign } from './microsoft.ts';
import {
  carryOut,
  destinations,
  planFor,
  readPublished,
  registerIdChange,
  signFor,
  statusRows,
  openFile,
  type Destination,
  type Done,
  type Plan,
  type PlanOptions,
  type StatusRow,
} from './publish.ts';
import { credentialsFile, dropTeamsSignIn, keepTeamsSignIn, teamsSignIn } from './tokens.ts';

export interface Account {
  name: string;
  username: string;
  can_edit: boolean;
}

export interface LoginStart {
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export type LoginPoll = { state: 'pending' | 'slower' } | { state: 'done'; account: Account };

export interface FileStanding {
  file: string;
  title: string;
  rows: Array<{ destination: string; state: 'current' | 'changed' | 'unpublished'; url: string | null; at: string | null; by: string | null }>;
}

export interface ChannelsApi {
  destinations(): Destination[];
  account(): Account | null;
  connect(name: string, provider: string, link: string): Promise<Destination>;
  disconnect(name: string): Promise<void>;
  loginStart(edit: boolean): Promise<LoginStart>;
  loginPoll(): Promise<LoginPoll>;
  logout(): boolean;
  plan(file: string, destination: string, options?: PlanOptions): Plan;
  publish(file: string, destination: string, options?: PlanOptions): Promise<Done>;
  status(destination?: string): StatusRow[];
  // one open file against each destination, for the page's view
  standing(file: string): FileStanding;
}

const accountOf = (held: { name: string; username: string; scopes: string[] }): Account => ({ name: held.name, username: held.username, can_edit: canEdit(held.scopes) });

const SLACK_LATER = 'Slack is not available yet; this release publishes to Microsoft Teams.';

const entry: CliEntry = {
  register(host: Host) {
    registerIdChange(host);

    const clientId = (): string => {
      const id = String(host.settings().get<string>('client_id') ?? '').trim() || DEFAULT_CLIENT_ID;
      if (!id) throw new ProviderError("No Microsoft Entra app is set. Set your organization's with `eidos plugin set channels client_id <id>`.", null);
      return id;
    };

    let pending: { sign: Sign; deviceCode: string } | null = null;

    const api: ChannelsApi = {
      destinations: () => destinations(host),
      account: () => {
        const held = teamsSignIn();
        return held ? accountOf(held) : null;
      },
      connect: async (name, provider, link) => {
        const named = name.trim();
        if (provider === 'slack') throw new ProviderError(SLACK_LATER, null);
        if (provider !== 'teams') throw new ProviderError(`${provider} is not a provider. Use teams.`, null);
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(named)) throw new ProviderError('A destination is named with letters, digits, and hyphens, such as team-updates.', null);
        const held = destinations(host);
        if (held.some((destination) => destination.name.toLowerCase() === named.toLowerCase())) throw new ProviderError(`There is already a destination called ${named}.`, null);
        const read = readChannelLink(link);
        const destination: Destination = { name: named, provider: 'teams', team: read.team, channel: read.channel, channel_name: read.channel_name, tenant: read.tenant };
        await host.settings().set('destinations', [...held, destination]);
        host.emit('changed', {});
        return destination;
      },
      disconnect: async (name) => {
        const held = destinations(host);
        const next = held.filter((destination) => destination.name.toLowerCase() !== name.trim().toLowerCase());
        if (next.length === held.length) throw new ProviderError(`There is no destination called ${name}.`, null);
        await host.settings().set('destinations', next);
        host.emit('changed', {});
      },
      loginStart: async (edit) => {
        const sign = signFor(host, permissionsFor(edit), clientId());
        const code = await startDeviceCode(sign);
        pending = { sign, deviceCode: code.device_code };
        return { user_code: code.user_code, verification_uri: code.verification_uri, interval: code.interval, expires_in: code.expires_in };
      },
      loginPoll: async () => {
        if (!pending) throw new ProviderError('No sign-in is under way.', null);
        const { sign, deviceCode } = pending;
        let poll;
        try {
          poll = await pollDeviceCode(sign, deviceCode);
        } catch (cause) {
          pending = null;
          throw cause;
        }
        if (poll.state !== 'done') return { state: poll.state };
        pending = null;
        const { tokens } = poll;
        const signIn = { refresh_token: tokens.refresh_token, scopes: tokens.scopes, name: tokens.name, username: tokens.username, tenant: tokens.tenant, client_id: sign.clientId };
        keepTeamsSignIn(signIn);
        host.emit('changed', {});
        return { state: 'done', account: accountOf(signIn) };
      },
      logout: () => {
        const dropped = dropTeamsSignIn();
        if (dropped) host.emit('changed', {});
        return dropped;
      },
      plan: (file, destination, options) => planFor(host, file, destination, options),
      publish: (file, destination, options) => carryOut(host, file, destination, clientId(), options),
      status: (destination) => statusRows(host, destination),
      standing: (ref) => {
        const file = openFile(host, ref);
        const held = readPublished(host)[file.key] ?? {};
        const rows = destinations(host).map((destination) => {
          const sent = held[destination.name];
          if (!sent) return { destination: destination.name, state: 'unpublished' as const, url: null, at: null, by: null };
          const plan = planFor(host, file.key, destination.name);
          return { destination: destination.name, state: plan.action === 'none' ? ('current' as const) : ('changed' as const), url: sent.url, at: sent.at, by: sent.by };
        });
        return { file: file.key, title: file.title, rows };
      },
    };

    const print = (text: string): void => {
      process.stdout.write(`${text}\n`);
    };
    const json = (value: unknown): void => print(JSON.stringify(value, null, 2));
    const action =
      <A extends unknown[]>(work: (...args: A) => void | Promise<void>) =>
      async (...args: A): Promise<void> => {
        try {
          await work(...args);
        } catch (cause) {
          process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
          process.exitCode = 1;
        }
      };

    host.command((command) => {
      command.description('Publish a blueprint or a top-level doc to a Microsoft Teams channel as one message, edited in place when the file changes');

      command
        .command('login')
        .argument('<provider>', 'teams')
        .option('--edit', 'also ask for permission to edit messages in place, which your administrator must approve')
        .description('sign in to Microsoft with a code you enter in your browser; a message is posted as you')
        .action(
          action(async (provider: string, options: { edit?: boolean }) => {
            if (provider === 'slack') throw new ProviderError(SLACK_LATER, null);
            if (provider !== 'teams') throw new ProviderError(`${provider} is not a provider. Use teams.`, null);
            const start = await api.loginStart(options.edit === true);
            print(`Go to ${start.verification_uri} and enter the code ${start.user_code}`);
            let interval = start.interval;
            for (;;) {
              await new Promise((resolve) => setTimeout(resolve, interval * 1000));
              const poll = await api.loginPoll();
              if (poll.state === 'slower') interval += 5;
              if (poll.state !== 'done') continue;
              print(`Signed in as ${poll.account.name || poll.account.username}. The sign-in is kept in ${credentialsFile()}.`);
              print(
                poll.account.can_edit
                  ? 'A change to a published file edits its message in place.'
                  : 'A change to a published file posts a new message. To edit in place instead, run `eidos channels login teams --edit`; your administrator must approve it.',
              );
              return;
            }
          }),
        );

      command
        .command('logout')
        .argument('<provider>', 'teams')
        .description('forget your sign-in on this machine')
        .action(
          action((provider: string) => {
            if (provider !== 'teams') throw new ProviderError(`${provider} is not a provider. Use teams.`, null);
            print(api.logout() ? 'Signed out of Teams.' : 'You were not signed in to Teams.');
          }),
        );

      command
        .command('whoami')
        .option('--json', 'print as JSON')
        .description('who is signed in on this machine, and whether they can edit messages')
        .action(
          action((options: { json?: boolean }) => {
            const account = api.account();
            if (options.json) return json({ teams: account });
            print(account ? `Teams: ${account.name || account.username}, ${account.can_edit ? 'can edit messages' : 'posts and replies only'}` : 'Teams: not signed in');
          }),
        );

      command
        .command('connect')
        .argument('<name>', "the destination's name")
        .requiredOption('--channel <link>', "the channel's link from Teams (Get link to channel)")
        .option('--provider <provider>', 'teams', 'teams')
        .option('--json', 'print as JSON')
        .description('add a channel this root publishes to')
        .action(
          action(async (name: string, options: { channel: string; provider: string; json?: boolean }) => {
            const destination = await api.connect(name, options.provider, options.channel);
            if (options.json) return json(destination);
            print(`Added ${destination.name}${destination.channel_name ? `, the ${destination.channel_name} channel` : ''}.`);
          }),
        );

      command
        .command('disconnect')
        .argument('<name>', "the destination's name")
        .description('remove a destination; messages already sent stay in the channel')
        .action(
          action(async (name: string) => {
            await api.disconnect(name);
            print(`Removed ${name}. Its messages stay in the channel.`);
          }),
        );

      command
        .command('destinations')
        .option('--json', 'print as JSON')
        .description('the channels this root publishes to')
        .action(
          action((options: { json?: boolean }) => {
            const rows = api.destinations();
            if (options.json) return json(rows);
            if (rows.length === 0) print('No destinations yet. Add one with `eidos channels connect <name> --channel <link>`.');
            for (const row of rows) print(`${row.name}  ${row.provider}  ${row.channel_name}`);
          }),
        );

      command
        .command('publish')
        .argument('<file>', "a blueprint's id or path, or a top-level doc's path")
        .requiredOption('--to <destination>', 'the destination')
        .option('--dry-run', 'print the message and the decision, and send nothing; no sign-in needed')
        .option('--force', 'edit the message even though the file did not change')
        .option('--no-reply', 'edit without replying in the thread')
        .option('--json', 'print as JSON')
        .description('post the file as one message, or edit that message when the file changed')
        .action(
          action(async (file: string, options: { to: string; dryRun?: boolean; force?: boolean; reply?: boolean; json?: boolean }) => {
            const planOptions: PlanOptions = { ...(options.force ? { force: true } : {}), ...(options.reply === false ? { noReply: true } : {}) };
            if (options.dryRun) {
              const plan = api.plan(file, options.to, planOptions);
              if (options.json) json({ ...plan, dry_run: true });
              else {
                print(
                  `${plan.action === 'none' ? 'Nothing to send' : plan.action === 'refused' ? 'Refused' : `Would ${plan.action === 'repost' ? 'post a new message' : plan.action}`}: ${plan.title} to ${plan.destination}. ${plan.reason}`,
                );
                if (plan.action !== 'none' && plan.action !== 'refused') print(`\n${plan.message}`);
                if (plan.reply) print(`\nWould reply in the thread:\n${plan.reply.map((line) => `  ${line}`).join('\n')}`);
              }
              if (plan.action === 'refused') process.exitCode = 1;
              return;
            }
            const done = await api.publish(file, options.to, planOptions);
            if (options.json) json(done);
            else {
              const said = { posted: 'Posted', edited: 'Edited', reposted: 'Posted a new message', replaced: 'Replaced', unchanged: 'Nothing to send' }[done.outcome];
              print(`${said}: ${done.file} to ${done.destination}. ${done.reason}${done.replied ? ' Replied in the thread.' : ''}`);
              if (done.url) print(done.url);
              if (done.reply_error) print(`The message is up to date, but the reply did not send: ${done.reply_error}`);
            }
            if (done.reply_error) process.exitCode = 1;
          }),
        );

      command
        .command('status')
        .argument('[destination]', 'one destination; every one when none is named')
        .option('--json', 'print as JSON')
        .description('each published file and destination, and whether the file changed since its last publish, read from the root alone')
        .action(
          action((destination: string | undefined, options: { json?: boolean }) => {
            const rows = api.status(destination);
            if (options.json) return json(rows);
            if (rows.length === 0) print('Nothing has been published from this root yet.');
            const words = { current: 'current', changed: 'changed since its last publish', missing: 'its file left the root' };
            for (const row of rows) print(`${row.file} → ${row.destination}: ${words[row.state]}`);
          }),
        );
    });
    return { api };
  },
};

export default entry;
