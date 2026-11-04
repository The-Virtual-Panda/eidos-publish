// What a publish does, whichever service it goes to (Publish REQ3 to REQ9, REQ19):
// where a file stands against the message last sent to a destination, the decision
// that follows, and carrying it out. What was sent is kept in `published.yaml`,
// shared with the root and written here alone, by blueprint id or a top-level doc's
// path and by destination. The published file is never written.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Host } from 'eidosmd/plugin';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { changeBetween, replyLines, worthReplying } from './change.ts';
import { ProviderError } from './errors.ts';
import { digest, parse, plainText, propertiesOf, type Parsed, type Property } from './render.ts';

export interface Destination {
  name: string;
  // the channel's name where its link gives one
  channel_name: string;
  // what says it is the same channel as a message was sent to
  key: string;
  // who a first post here mentions and what it shares, as they were last chosen
  mentions?: Mention[];
  properties?: string[];
  [field: string]: unknown;
}

// Someone a message notifies: a person, a tag of the team, or the channel itself.
export interface Mention {
  kind: 'person' | 'tag' | 'channel';
  id: string;
  name: string;
}

export interface Account {
  name: string;
  detail: string;
  can_edit: boolean;
  // false when this sign-in predates the permissions mentions take
  can_mention?: boolean;
}

export interface Sender {
  post(destination: Destination, message: string, mentions: Mention[]): Promise<{ id: string; url: string | null }>;
  // a message keeps its mentions through an edit, since an edit that left them out would strip them
  edit(destination: Destination, id: string, message: string, mentions: Mention[]): Promise<void>;
  reply(destination: Destination, id: string, message: string): Promise<void>;
}

// What a plugin tells the core about its service.
export interface Provider {
  // the plugin's name and its commands' word: `eidos <command> publish`
  command: string;
  // the service as a sentence names it
  service: string;
  limit: number;
  limitUnit: 'bytes' | 'characters';
  render(parsed: Parsed): string;
  // a short reply from its lines: the sections added, removed, and changed
  renderReply(lines: string[]): string;
  // a channel from what a person pastes, or a refusal saying what to paste
  readChannel(link: string): Omit<Destination, 'name'>;
  channelHelp: string;
  account(): Account | null;
  // why a person signed in like this posts a new message rather than editing, when they do
  cannotEdit: string;
  signIn: string;
  // a person posts as themselves, so a refused edit may be someone else's message
  // who can be mentioned, found by what a person types; a service that cannot mention leaves this out
  searchMentions?(destination: Destination, query: string): Promise<Mention[]>;
  postsAsPerson: boolean;
  sender(): Promise<Sender>;
  logout(): boolean;
}

export interface Sent {
  message_id: string;
  channel: string;
  url: string | null;
  digest: string;
  // the text as last sent, compressed: what the next publish measures a change against, with no request
  text: string;
  at: string;
  by: string;
  mentions?: Mention[];
  properties?: string[];
}

type Published = Record<string, Record<string, Sent>>;

export interface OpenFile {
  // what it is kept under: a blueprint's id, a top-level doc's path
  key: string;
  rel: string;
  title: string;
  kind: 'blueprint' | 'doc';
  message: string;
  plain: string;
  properties: Property[];
}

export type Action = 'post' | 'edit' | 'repost' | 'none' | 'refused';

export interface Plan {
  file: string;
  title: string;
  destination: string;
  action: Action;
  reason: string;
  message: string;
  size: number;
  limit: number;
  reply: string[] | null;
  url: string | null;
  // who posted the message, when sending would duplicate it, which the person confirms with `takeOver`
  posted_by_other?: string;
  // on a first post, what a person chooses: everything the file can share, and what is chosen so far
  first?: { properties: Property[]; chosen: string[]; mentions: Mention[]; can_mention: boolean };
}

export interface Done {
  file: string;
  destination: string;
  // `replaced`: the message was gone, so a new one took its place
  outcome: 'posted' | 'edited' | 'reposted' | 'replaced' | 'unchanged';
  reason: string;
  message_id: string | null;
  url: string | null;
  replied: boolean;
  reply_error?: string;
}

export interface PlanOptions {
  force?: boolean;
  noReply?: boolean;
  takeOver?: boolean;
  // chosen for a first post, and kept for that message and the channel's next one
  properties?: string[];
  mentions?: Mention[];
}

export interface StatusRow {
  file: string;
  destination: string;
  state: 'current' | 'changed' | 'missing';
  at: string;
  by: string;
  url: string | null;
}

const publishedFile = (host: Host): string => path.join(host.workspace, 'published.yaml');

const packText = (text: string): string => gzipSync(text).toString('base64');
const unpackText = (packed: string): string | null => {
  try {
    return gunzipSync(Buffer.from(packed, 'base64')).toString('utf8');
  } catch {
    return null;
  }
};

const readPublishedText = (text: string | null): Published => {
  if (!text) return {};
  try {
    return ((parseYaml(text) as { files?: Published } | null)?.files ?? {}) as Published;
  } catch {
    return {};
  }
};
const writePublishedText = (files: Published): string => `# What was published where, written by this plugin; never edit it.\n${stringifyYaml({ files }, { lineWidth: 0 })}`;

export function readPublished(host: Host): Published {
  const file = publishedFile(host);
  return existsSync(file) ? readPublishedText(readFileSync(file, 'utf8')) : {};
}

// Read again as its turn comes, so one person's publish never writes over another's.
async function record(host: Host, key: string, destination: string, sent: Sent): Promise<void> {
  await host.writeFile(publishedFile(host), (current) => {
    const files = readPublishedText(current);
    return writePublishedText({ ...files, [key]: { ...files[key], [destination]: sent } });
  });
}

// `eidos reid` carries a blueprint's id here too (Surfaces REQ12).
export function registerIdChange(host: Host): void {
  host.onIdChange((changes) => {
    const moved = changes.filter((change) => (change.kind === undefined || change.kind === 'blueprint') && readPublished(host)[change.from]);
    if (moved.length === 0) return [];
    return [
      {
        path: publishedFile(host),
        what: `the published messages of ${moved.map((change) => change.from).join(', ')}`,
        apply: () => {
          host.writeFileSync(publishedFile(host), (current) => {
            const files = readPublishedText(current);
            for (const change of moved) {
              const held = files[change.from];
              if (!held) continue;
              files[change.to] = held;
              delete files[change.from];
            }
            return writePublishedText(files);
          });
        },
      },
    ];
  });
}

export function destinations(host: Host): Destination[] {
  const held = host.settings().get<unknown>('destinations');
  return Array.isArray(held) ? (held as Destination[]) : [];
}

export function destinationNamed(host: Host, provider: Provider, name: string): Destination {
  const found = destinations(host).find((destination) => destination.name.toLowerCase() === name.trim().toLowerCase());
  if (found) return found;
  const names = destinations(host).map((destination) => destination.name);
  throw new ProviderError(`There is no destination called ${name}. ${names.length > 0 ? `This root has: ${names.join(', ')}.` : `Add one with \`eidos ${provider.command} connect\`.`}`, null);
}

// A blueprint by its id or path, or a top-level doc by its path: nothing else publishes.
export function openFile(host: Host, provider: Provider, ref: string, chosen: string[] = []): OpenFile {
  const context = host.context();
  const asPath = path.resolve(context.cwd, ref);
  const wanted = ref.trim().toLowerCase();
  const blueprint = context.blueprints.find((held) => path.resolve(held.path) === asPath || held.rel.toLowerCase() === wanted || String(held.properties?.['id'] ?? '').toLowerCase() === wanted);
  if (blueprint) {
    const id = blueprint.properties?.['id'];
    const title = blueprint.properties?.['title'];
    const source = readFileSync(blueprint.path, 'utf8');
    const parsed = parse(source, blueprint.stem, typeof title === 'string' ? title : undefined, chosen);
    return { key: typeof id === 'string' && id ? id : blueprint.rel, rel: blueprint.rel, title: parsed.title, kind: 'blueprint', properties: propertiesOf(source), message: provider.render(parsed), plain: plainText(parsed) };
  }
  // a top-level doc is declared relative to the framework document, and kept under its path from the root
  const inRoot = path.resolve(context.root, ref);
  for (const doc of context.framework.topLevel) {
    const file = path.resolve(path.dirname(context.framework.file), doc.path);
    const rel = path.relative(context.root, file).split(path.sep).join('/');
    if (file !== asPath && file !== inRoot && rel.toLowerCase() !== wanted) continue;
    if (!existsSync(file)) throw new ProviderError(`The top-level doc ${rel} is declared and has no file yet.`, null);
    const source = readFileSync(file, 'utf8');
    const parsed = parse(source, path.basename(file, '.md'), doc.title, chosen);
    return { key: rel, rel, title: parsed.title, kind: 'doc', properties: propertiesOf(source), message: provider.render(parsed), plain: plainText(parsed) };
  }
  throw new ProviderError(`${ref} is not a blueprint or a top-level doc of this root. Only those publish.`, null);
}

const sizeOf = (provider: Provider, message: string): number => (provider.limitUnit === 'bytes' ? Buffer.byteLength(message, 'utf8') : message.length);

// The decision, from the root and this machine alone (REQ5): what a dry run prints and what a publish carries out.
export function planFor(host: Host, provider: Provider, ref: string, name: string, options: PlanOptions = {}): Plan {
  const destination = destinationNamed(host, provider, name);
  const key = openFile(host, provider, ref).key;
  const sent = readPublished(host)[key]?.[destination.name];
  const firstPost = !sent || sent.channel !== destination.key;
  const chosen = firstPost ? (options.properties ?? destination.properties ?? []) : (sent.properties ?? []);
  const file = openFile(host, provider, ref, chosen);
  const size = sizeOf(provider, file.message);
  const base = { file: file.key, title: file.title, destination: destination.name, message: file.message, size, limit: provider.limit, reply: null, url: sent?.url ?? null };
  if (size > provider.limit) {
    const count = (value: number): string => `${value.toLocaleString('en-US')} ${provider.limitUnit}`;
    return { ...base, action: 'refused', reason: `The message is ${count(size)} and ${provider.service} allows ${count(provider.limit)}, so nothing is sent. Shorten the file.` };
  }
  const first = { properties: file.properties, chosen, mentions: options.mentions ?? destination.mentions ?? [], can_mention: provider.searchMentions !== undefined && provider.account()?.can_mention !== false };
  if (!sent) return { ...base, action: 'post', first, reason: 'It has not been published here yet.' };
  if (sent.channel !== destination.key) return { ...base, action: 'post', first, url: null, reason: `${destination.name} now points at another channel, so it takes a new message.` };
  const current = sent.digest === digest(file.message);
  const account = provider.account();
  // Only a message's author can edit it, so anything sent here is a second message: the person is told who posted it and says so before it goes.
  const me = [host.actingUser()?.alias, account?.name].filter(Boolean);
  const postedByOther = provider.postsAsPerson && Boolean(sent.by) && me.length > 0 && !me.includes(sent.by);
  if (current && !options.force && !(postedByOther && options.takeOver)) return { ...base, action: 'none', reason: 'The message already matches the file.' };
  if (postedByOther)
    return {
      ...base,
      action: 'repost',
      posted_by_other: sent.by,
      reason: `${sent.by} posted this message, and only they can edit it, so this posts a second message under your name and theirs stays in the channel. Asking them to publish it again keeps it as one message.`,
    };
  if (account && !account.can_edit) return { ...base, action: 'repost', reason: provider.cannotEdit };
  const before = unpackText(sent.text);
  const change = before === null ? null : changeBetween(before, file.plain);
  const settings = host.settings();
  const replying = change !== null && !current && !options.noReply && settings.get<boolean>('reply') !== false && worthReplying(change, Number(settings.get<number>('reply_min_chars') ?? 120));
  const reason = current ? 'The file did not change; --force edits the message anyway.' : 'The file changed since the last publish.';
  return { ...base, action: 'edit', reason: account ? reason : `${reason} ${provider.signIn}`, reply: replying && change ? replyLines(change) : null };
}

// A failure names the destination, the file, and what the provider said (REQ21).
const failure = (plan: Plan, cause: unknown, hint = ''): ProviderError =>
  new ProviderError(`${plan.destination}: ${plan.file}: ${cause instanceof Error ? cause.message : String(cause)}${hint}`, cause instanceof ProviderError ? cause.status : null);

// Carried out as planned. What an edit's failure means decides what happens
// (REQ8): the message gone takes a replacement; a lost permission, a throttle,
// or an outage changes nothing and posts nothing. A message is recorded as soon
// as it is sent, so a reply that fails afterwards never posts it a second time.
export async function carryOut(host: Host, provider: Provider, ref: string, name: string, options: PlanOptions = {}): Promise<Done> {
  const plan = planFor(host, provider, ref, name, options);
  const destination = destinationNamed(host, provider, name);
  const earlier = readPublished(host)[openFile(host, provider, ref).key]?.[destination.name];
  const firstPost = plan.first !== undefined;
  const mentions = plan.first?.mentions ?? earlier?.mentions ?? [];
  const properties = plan.first?.chosen ?? earlier?.properties ?? [];
  const file = openFile(host, provider, ref, properties);
  const done = { file: plan.file, destination: plan.destination, reason: plan.reason };
  if (plan.action === 'refused') throw new ProviderError(`${plan.destination}: ${plan.file}: ${plan.reason}`, null);
  if (plan.posted_by_other && !options.takeOver) throw new ProviderError(`${plan.destination}: ${plan.file}: ${plan.reason} Publish with --take-over to post it anyway.`, null);
  const sent = readPublished(host)[file.key]?.[destination.name];
  if (plan.action === 'none') return { ...done, outcome: 'unchanged', message_id: sent?.message_id ?? null, url: sent?.url ?? null, replied: false };
  let sender: Sender;
  try {
    sender = await provider.sender();
  } catch (cause) {
    throw cause instanceof ProviderError ? failure(plan, cause) : cause;
  }
  const by = host.actingUser()?.alias ?? provider.account()?.name ?? '';
  const keep = async (id: string, url: string | null): Promise<void> => {
    await record(host, file.key, destination.name, { message_id: id, channel: destination.key, url, digest: digest(file.message), text: packText(file.plain), at: new Date().toISOString(), by, ...(mentions.length > 0 ? { mentions } : {}), ...(properties.length > 0 ? { properties } : {}) });
    host.emit('changed', { file: file.key, destination: destination.name });
  };
  const postNew = async (outcome: 'posted' | 'reposted' | 'replaced', reason: string): Promise<Done> => {
    let posted;
    try {
      posted = await sender.post(destination, file.message, firstPost ? mentions : []);
    } catch (cause) {
      throw failure(plan, cause);
    }
    await keep(posted.id, posted.url);
    if (firstPost && (options.mentions || options.properties)) {
      const held = destinations(host).map((entry) => (entry.name === destination.name ? { ...entry, mentions, properties } : entry));
      await host.settings().set('destinations', held);
    }
    return { ...done, outcome, reason, message_id: posted.id, url: posted.url, replied: false };
  };
  if (plan.action === 'post') return postNew('posted', plan.reason);
  if (plan.action === 'repost') return postNew('reposted', plan.posted_by_other ? `It replaces ${plan.posted_by_other}'s as the message kept here; theirs stays in the channel.` : plan.reason);
  const message = sent!;
  try {
    await sender.edit(destination, message.message_id, file.message, mentions);
  } catch (cause) {
    const status = cause instanceof ProviderError ? cause.status : null;
    if (status === 404 || status === 410) return postNew('replaced', `The message was gone from ${provider.service}, so a new one took its place.`);
    const someoneElse = provider.postsAsPerson && status === 403 && message.by && message.by !== by ? ` The message was posted by ${message.by}; only they may be able to edit it.` : '';
    throw failure(plan, cause, someoneElse);
  }
  await keep(message.message_id, message.url);
  const edited: Done = { ...done, outcome: 'edited', message_id: message.message_id, url: message.url, replied: false };
  if (plan.reply === null) return edited;
  try {
    await sender.reply(destination, message.message_id, provider.renderReply(plan.reply));
    return { ...edited, replied: true };
  } catch (cause) {
    return { ...edited, reply_error: cause instanceof Error ? cause.message : String(cause) };
  }
}

// From the root alone (REQ9): no request, no sign-in.
export function statusRows(host: Host, provider: Provider, only?: string): StatusRow[] {
  const rows: StatusRow[] = [];
  for (const [key, held] of Object.entries(readPublished(host))) {
    let message: string | null = null;
    try {
      message = openFile(host, provider, key).message;
    } catch {
      // the file left the root: its message stays and stops being edited
    }
    for (const [name, sent] of Object.entries(held)) {
      if (only && name.toLowerCase() !== only.trim().toLowerCase()) continue;
      rows.push({ file: key, destination: name, state: message === null ? 'missing' : digest(message) === sent.digest ? 'current' : 'changed', at: sent.at, by: sent.by, url: sent.url });
    }
  }
  return rows;
}
