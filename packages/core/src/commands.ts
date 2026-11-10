// The commands and the API every publishing plugin has in common: destinations,
// publish, and status. A plugin adds its own `login`, since signing in is where the
// services differ.
import type { Host } from 'eidosmd/plugin';
import { ProviderError } from './errors.ts';
import { channelLabel } from './label.ts';
import { confirm } from './prompt.ts';
import {
  carryOut,
  defaultMentions,
  destinationNamed,
  destinations,
  openFile,
  planFor,
  readPublished,
  registerIdChange,
  statusRows,
  type Account,
  type Destination,
  type Done,
  type Mention,
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

export interface PublishOptions {
  reply: boolean;
  reply_min_chars: number;
  default_mentions: Mention[];
}

export interface PublishApi {
  destinations(): Destination[];
  account(): Account | null;
  // the name is optional: a channel's link usually says it
  connect(name: string | undefined, link: string): Promise<Destination>;
  // looks up the team of each channel saved without one; never fails, since a channel works without it
  fillTeamNames(): Promise<void>;
  disconnect(name: string): Promise<void>;
  // what the plugin's page draws itself, in words
  // who a message could mention, for the page's picker
  // with no channel named, across every channel, for the project's default
  searchMentions(destination: string | undefined, query: string): Promise<Mention[]>;
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

export const isMention = (value: unknown): value is Mention => {
  const held = value as Partial<Mention> | null;
  return typeof held === 'object' && held !== null && ['person', 'tag', 'channel'].includes(String(held.kind)) && typeof held.id === 'string' && typeof held.name === 'string';
};

const optionsOf = (host: Host, provider: Provider): PublishOptions => {
  const settings = host.settings();
  return {
    reply: settings.get<boolean>('reply') !== false,
    reply_min_chars: Number(settings.get<number>('reply_min_chars') ?? 120),
    default_mentions: defaultMentions(host, provider),
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
  // the channels already asked about, so a team that cannot be found is not asked for again every time the page loads
  const asked = new Set<string>();
  let filling: Promise<void> | null = null;
  const fill = async (): Promise<void> => {
    const missing = destinations(host).filter((destination) => !destination.team_name && !asked.has(destination.key));
    if (missing.length === 0) return;
    const names = await provider.teamNames?.(missing);
    if (!names) return;
    for (const destination of missing) asked.add(destination.key);
    if (!missing.some((destination) => names[destination.key])) return;
    // read again: the lookup took a while, and a channel may have been added or removed meanwhile
    const next = destinations(host).map((destination) => (!destination.team_name && names[destination.key] ? { ...destination, team_name: names[destination.key] as string } : destination));
    await host.settings().set('destinations', next);
    host.emit('changed', {});
  };
  return {
    destinations: () => destinations(host),
    account: () => provider.account(),
    connect: async (name, link) => {
      const fromLink = provider.readChannel(link);
      // a channel's name is a nicety: one that cannot be found never stops it being added
      const looked = fromLink.channel_name ? '' : await (provider.channelName?.(fromLink) ?? Promise.resolve('')).catch(() => '');
      const read = looked ? { ...fromLink, channel_name: looked } : fromLink;
      const held = destinations(host);
      const taken = (candidate: string): boolean => held.some((destination) => destination.name.toLowerCase() === candidate);
      const given = (name ?? '').trim();
      let named = slugged(given);
      if (given) {
        if (!named) throw new ProviderError('A destination needs a name with at least one letter or digit, such as team-updates.', null);
        if (taken(named)) throw new ProviderError(`There is already a destination called ${named}.`, null);
      } else {
        const already = held.find((destination) => destination.key === read.key);
        if (already) throw new ProviderError(`This channel is already added, as ${channelLabel(already)}.`, null);
        // a channel whose name is not known is called after the service, never by its raw id
        const base = slugged(String(read.channel_name ?? '')) || `${provider.command}-channel`;
        named = base;
        for (let n = 2; taken(named); n += 1) named = `${base}-${n}`;
      }
      const team = (await provider.teamNames?.([read]))?.[String(read.key)];
      const destination = { name: named, ...read, channel_name: read.channel_name || (given !== named ? given : ''), ...(team ? { team_name: team } : {}) } as Destination;
      await host.settings().set('destinations', [...held, destination]);
      host.emit('changed', {});
      return destination;
    },
    fillTeamNames: () => {
      filling ??= fill()
        .catch(() => undefined)
        .finally(() => {
          filling = null;
        });
      return filling;
    },
    searchMentions: async (name, query) => {
      if (!provider.searchMentions) return [];
      const channels = name ? [destinationNamed(host, provider, name)] : destinations(host);
      const found = await Promise.all(channels.map((channel) => provider.searchMentions!(channel, query)));
      return [...new Map(found.flat().map((mention) => [`${mention.kind}:${mention.id}`, mention])).values()];
    },
    options: () => optionsOf(host, provider),
    setOption: async (name, value) => {
      const settings = host.settings();
      if (name === 'reply') await settings.set(name, value === true);
      else if (name === 'default_mentions' && provider.searchMentions) await settings.set(name, Array.isArray(value) ? value.filter(isMention) : []);
      else if (name === 'reply_min_chars') {
        const chars = Number(value);
        if (!Number.isInteger(chars) || chars < 0) throw new ProviderError('The size of a change is a whole number of characters.', null);
        await settings.set(name, chars);
      } else throw new ProviderError(`There is no setting called ${name}.`, null);
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
        if (!sent) return { destination: destination.name, label: channelLabel(destination), state: 'unpublished' as const, url: null, at: null, by: null };
        const plan = planFor(host, provider, file.key, destination.name);
        return { destination: destination.name, label: channelLabel(destination), state: plan.action === 'none' ? ('current' as const) : ('changed' as const), url: sent.url, at: sent.at, by: sent.by };
      });
      return { file: file.key, title: file.title, rows };
    },
  };
}

// A name that finds nobody stops the run: a mention that resolves to no one would look right and notify no one.
async function resolveMentions(api: PublishApi, destination: string, names: string[]): Promise<Mention[]> {
  const found: Mention[] = [];
  for (const given of names) {
    const name = given.replace(/^@/, '').trim().toLowerCase();
    const matches = (await api.searchMentions(destination, name)).filter((mention) => mention.name.toLowerCase() === name);
    if (matches.length !== 1) throw new ProviderError(matches.length === 0 ? `Nobody called ${given} can be mentioned here, so nothing was sent.` : `More than one ${given} can be mentioned here, so nothing was sent.`, null);
    found.push(matches[0]!);
  }
  return found;
}

// A step for Automations: the file that started the run, or the one named, to a channel. It takes who to mention and
// what to share from the channel's last choice, and never posts a duplicate unless the automation says to.
export function automationSteps(provider: Provider, api: PublishApi): { actions: object[] } {
  const SECOND = 'Post a second message';
  return {
    actions: [
      {
        id: `${provider.command}.publish`,
        title: `Publish to ${provider.service}`,
        plugin: provider.command,
        description: `Posts the file as one ${provider.service} message, or edits that message when the file changed`,
        where: 'anywhere',
        leaves: true,
        get fields() {
          const channels = api.destinations().map((destination) => destination.name);
          return [
            { name: 'channel', title: 'Channel', ...(channels.length > 0 ? { options: channels } : {}) },
            { name: 'file', title: 'File (empty: the one that started the run)' },
            ...(provider.postsAsPerson ? [{ name: 'other_author', title: 'If someone else posted the message', options: ['Stop', SECOND] }] : []),
          ];
        },
        run: async ({ subject, with: given }: { subject: { id?: string; path?: string }; with: Record<string, string> }): Promise<{ text: string }> => {
          const file = given['file'] || subject.id || subject.path;
          if (!file) throw new Error('Nothing to publish: start this on a blueprint or a top-level doc, or name a file.');
          const channel = given['channel'] || (api.destinations().length === 1 ? api.destinations()[0]!.name : '');
          if (!channel) throw new Error('Choose the channel this step publishes to.');
          const done = await api.publish(file, channel, given['other_author'] === SECOND ? { takeOver: true } : {});
          if (done.reply_error) throw new Error(`The message is up to date, but the reply did not send: ${done.reply_error}`);
          return { text: `${done.outcome}: ${done.file} to ${done.destination}${done.url ? ` ${done.url}` : ''}` };
        },
      },
    ],
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
          print(`Added ${destination.name}${destination.channel_name ? `, the ${destination.channel_name} channel${destination.team_name ? ` in ${destination.team_name}` : ''}` : ''}.`);
          if (!name && !destination.channel_name) print(`${service} did not say what the channel is called. To name it yourself, remove it and add it again with a name: \`eidos ${word} connect <name> --channel <link>\`.`);
          const help = destination.team_name ? '' : provider.teamNameHelp?.();
          if (help) print(help);
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
          for (const row of rows) print(row.channel_name ? `${row.name}  ${channelLabel(row)}` : row.name);
        }),
      );

    const publish = command
      .command('publish')
      .argument('<file>', "a blueprint's id or path, or a top-level doc's path")
      .requiredOption('--to <destination>', 'the destination')
      .option('--dry-run', 'print the message and the decision, and send nothing; no sign-in needed')
      .option('--force', 'edit the message even though the file did not change')
      .option('--no-reply', 'edit without replying in the thread')
      .option('--json', 'print as JSON')
      .option('--property <name...>', 'on a first post, the frontmatter properties to share');
    if (provider.searchMentions) publish.option('--mention <name...>', 'on a first post, the people or tags to mention, each checked before anything is sent');
    if (provider.postsAsPerson) publish.option('--take-over', "post a second message under your name in place of someone else's, without asking");
    publish
      .description('post the file as one message, or edit that message when the file changed')
      .action(
        action(async (file: string, options: { to: string; dryRun?: boolean; force?: boolean; reply?: boolean; json?: boolean; takeOver?: boolean; property?: string[]; mention?: string[] }) => {
          const planOptions: PlanOptions = { ...(options.force ? { force: true } : {}), ...(options.reply === false ? { noReply: true } : {}), ...(options.takeOver ? { takeOver: true } : {}), ...(options.property ? { properties: options.property } : {}) };
          if (options.mention) planOptions.mentions = await resolveMentions(api, options.to, options.mention);
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
