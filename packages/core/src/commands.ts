// The commands and the API every publishing plugin has in common: destinations,
// publish, and status. A plugin adds its own `login`, since signing in is where the
// services differ.
import type { Host } from 'eidosmd/plugin';
import { ProviderError } from './errors.ts';
import { confirm } from './prompt.ts';
import {
  carryOut,
  destinations,
  openFile,
  planFor,
  readPublished,
  registerIdChange,
  statusRows,
  type Account,
  type Destination,
  type Done,
  type Plan,
  type PlanOptions,
  type Provider,
  type StatusRow,
} from './publish.ts';

export interface FileStanding {
  file: string;
  title: string;
  rows: Array<{ destination: string; state: 'current' | 'changed' | 'unpublished'; url: string | null; at: string | null; by: string | null }>;
}

export type PublishOptions = { reply: boolean; reply_min_chars: number } & Record<string, unknown>;

export interface PublishApi {
  destinations(): Destination[];
  account(): Account | null;
  // the name is optional: a channel's link usually says it
  connect(name: string | undefined, link: string): Promise<Destination>;
  disconnect(name: string): Promise<void>;
  // what the plugin's page draws itself, in words
  options(): PublishOptions;
  setOption(name: string, value: unknown): Promise<PublishOptions>;
  logout(): boolean;
  plan(file: string, destination: string, options?: PlanOptions): Plan;
  publish(file: string, destination: string, options?: PlanOptions): Promise<Done>;
  status(destination?: string): StatusRow[];
  // one open file against each destination, for the page's view
  standing(file: string): FileStanding;
}

export const print = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => print(JSON.stringify(value, null, 2));

export const action =
  <A extends unknown[]>(work: (...args: A) => void | Promise<void>) =>
  async (...args: A): Promise<void> => {
    try {
      await work(...args);
    } catch (cause) {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    }
  };

const optionsOf = (host: Host, provider: Provider): PublishOptions => {
  const settings = host.settings();
  return {
    reply: settings.get<boolean>('reply') !== false,
    reply_min_chars: Number(settings.get<number>('reply_min_chars') ?? 120),
    ...Object.fromEntries((provider.textSettings ?? []).map((name) => [name, String(settings.get<string>(name) ?? '')])),
  };
};

// What a destination is called in `--to` and the settings file, from any words.
const slugged = (words: string): string =>
  words
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function publishApi(host: Host, provider: Provider): PublishApi {
  return {
    destinations: () => destinations(host),
    account: () => provider.account(),
    connect: async (name, link) => {
      const read = provider.readChannel(link);
      const held = destinations(host);
      const taken = (candidate: string): boolean => held.some((destination) => destination.name.toLowerCase() === candidate);
      const given = (name ?? '').trim();
      let named = slugged(given);
      if (given) {
        if (!named) throw new ProviderError('A destination needs a name with at least one letter or digit, such as team-updates.', null);
        if (taken(named)) throw new ProviderError(`There is already a destination called ${named}.`, null);
      } else {
        const already = held.find((destination) => destination.key === read.key);
        if (already) throw new ProviderError(`This channel is already added, as ${already.channel_name || already.name}.`, null);
        const base = slugged(String(read.channel_name ?? '')) || slugged(String(read.key)) || 'channel';
        named = base;
        for (let n = 2; taken(named); n += 1) named = `${base}-${n}`;
      }
      const destination = { name: named, ...read, channel_name: read.channel_name || (given !== named ? given : '') } as Destination;
      await host.settings().set('destinations', [...held, destination]);
      host.emit('changed', {});
      return destination;
    },
    options: () => optionsOf(host, provider),
    setOption: async (name, value) => {
      const settings = host.settings();
      if (name === 'reply') await settings.set(name, value === true);
      else if (name === 'reply_min_chars') {
        const chars = Number(value);
        if (!Number.isInteger(chars) || chars < 0) throw new ProviderError('The size of a change is a whole number of characters.', null);
        await settings.set(name, chars);
      } else if (provider.textSettings?.includes(name)) await settings.set(name, String(value ?? '').trim());
      else throw new ProviderError(`There is no setting called ${name}.`, null);
      host.emit('changed', {});
      return optionsOf(host, provider);
    },
    disconnect: async (name) => {
      const held = destinations(host);
      const next = held.filter((destination) => destination.name.toLowerCase() !== name.trim().toLowerCase());
      if (next.length === held.length) throw new ProviderError(`There is no destination called ${name}.`, null);
      await host.settings().set('destinations', next);
      host.emit('changed', {});
    },
    logout: () => {
      const dropped = provider.logout();
      if (dropped) host.emit('changed', {});
      return dropped;
    },
    plan: (file, destination, options) => planFor(host, provider, file, destination, options),
    publish: (file, destination, options) => carryOut(host, provider, file, destination, options),
    status: (destination) => statusRows(host, provider, destination),
    standing: (ref) => {
      const file = openFile(host, provider, ref);
      const held = readPublished(host)[file.key] ?? {};
      const rows = destinations(host).map((destination) => {
        const sent = held[destination.name];
        if (!sent) return { destination: destination.name, state: 'unpublished' as const, url: null, at: null, by: null };
        const plan = planFor(host, provider, file.key, destination.name);
        return { destination: destination.name, state: plan.action === 'none' ? ('current' as const) : ('changed' as const), url: sent.url, at: sent.at, by: sent.by };
      });
      return { file: file.key, title: file.title, rows };
    },
  };
}

export function registerPublish(host: Host, provider: Provider, api: PublishApi): void {
  registerIdChange(host);
  const { service, command: word } = provider;
  host.command((command) => {
    command
      .command('logout')
      .description('forget your sign-in on this machine')
      .action(
        action(() => {
          print(api.logout() ? `Signed out of ${service}.` : `You were not signed in to ${service}.`);
        }),
      );

    command
      .command('whoami')
      .option('--json', 'print as JSON')
      .description('who is signed in on this machine, and whether a change edits its message')
      .action(
        action((options: { json?: boolean }) => {
          const account = api.account();
          if (options.json) return json({ account });
          print(account ? `${service}: ${account.name}${account.detail ? `, ${account.detail}` : ''}` : `${service}: not signed in`);
        }),
      );

    command
      .command('connect')
      .argument('[name]', "what to call it in --to; taken from the channel when left out")
      .requiredOption('--channel <link>', provider.channelHelp)
      .option('--json', 'print as JSON')
      .description('add a channel this root publishes to')
      .action(
        action(async (name: string | undefined, options: { channel: string; json?: boolean }) => {
          const destination = await api.connect(name, options.channel);
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
          if (rows.length === 0) print(`No destinations yet. Add one with \`eidos ${word} connect <name> --channel <link>\`.`);
          for (const row of rows) print(`${row.name}  ${row.channel_name}`.trimEnd());
        }),
      );

    const publish = command
      .command('publish')
      .argument('<file>', "a blueprint's id or path, or a top-level doc's path")
      .requiredOption('--to <destination>', 'the destination')
      .option('--dry-run', 'print the message and the decision, and send nothing; no sign-in needed')
      .option('--force', 'edit the message even though the file did not change')
      .option('--no-reply', 'edit without replying in the thread')
      .option('--json', 'print as JSON');
    if (provider.postsAsPerson) publish.option('--take-over', "post a second message under your name in place of someone else's, without asking");
    publish
      .description('post the file as one message, or edit that message when the file changed')
      .action(
        action(async (file: string, options: { to: string; dryRun?: boolean; force?: boolean; reply?: boolean; json?: boolean; takeOver?: boolean }) => {
          const planOptions: PlanOptions = { ...(options.force ? { force: true } : {}), ...(options.reply === false ? { noReply: true } : {}), ...(options.takeOver ? { takeOver: true } : {}) };
          if (options.dryRun) {
            const plan = api.plan(file, options.to, planOptions);
            if (options.json) json({ ...plan, dry_run: true });
            else {
              print(
                `${plan.action === 'none' ? 'Nothing to send' : plan.action === 'refused' ? 'Refused' : `Would ${plan.action === 'repost' ? 'post a new message' : plan.action}`}: ${plan.title} to ${plan.destination}. ${plan.reason}`,
              );
              if (plan.action !== 'none' && plan.action !== 'refused') print(`\n${plan.message}`);
              if (plan.reply) print(`\nWould reply in the thread:\n${plan.reply.map((line) => `  ${line}`).join('\n')}`);
              if (plan.posted_by_other) print('\nPublishing asks you to confirm this first; --take-over skips that.');
            }
            if (plan.action === 'refused') process.exitCode = 1;
            return;
          }
          const planned = api.plan(file, options.to, planOptions);
          if (planned.posted_by_other && !options.takeOver && process.stdin.isTTY) {
            if (!(await confirm(`${planned.reason}\nPost a second message anyway?`))) {
              print('Nothing was sent.');
              return;
            }
            planOptions.takeOver = true;
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
}
