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
import { digest, parse, plainText, type Parsed } from './render.ts';

export interface Destination {
  name: string;
  // the channel's name where its link gives one
  channel_name: string;
  // what says it is the same channel as a message was sent to
  key: string;
  [field: string]: unknown;
}

export interface Account {
  name: string;
  detail: string;
  can_edit: boolean;
}

export interface Sender {
  post(destination: Destination, message: string): Promise<{ id: string; url: string | null }>;
  edit(destination: Destination, id: string, message: string): Promise<void>;
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

function destinationNamed(host: Host, provider: Provider, name: string): Destination {
  const found = destinations(host).find((destination) => destination.name.toLowerCase() === name.trim().toLowerCase());
  if (found) return found;
  const names = destinations(host).map((destination) => destination.name);
  throw new ProviderError(`There is no destination called ${name}. ${names.length > 0 ? `This root has: ${names.join(', ')}.` : `Add one with \`eidos ${provider.command} connect\`.`}`, null);
}

// A blueprint by its id or path, or a top-level doc by its path: nothing else publishes.
export function openFile(host: Host, provider: Provider, ref: string): OpenFile {
  const context = host.context();
  const asPath = path.resolve(context.cwd, ref);
  const wanted = ref.trim().toLowerCase();
  const blueprint = context.blueprints.find((held) => path.resolve(held.path) === asPath || held.rel.toLowerCase() === wanted || String(held.properties?.['id'] ?? '').toLowerCase() === wanted);
  if (blueprint) {
    const id = blueprint.properties?.['id'];
    const title = blueprint.properties?.['title'];
    const parsed = parse(readFileSync(blueprint.path, 'utf8'), blueprint.stem, typeof title === 'string' ? title : undefined);
    return { key: typeof id === 'string' && id ? id : blueprint.rel, rel: blueprint.rel, title: parsed.title, kind: 'blueprint', message: provider.render(parsed), plain: plainText(parsed) };
  }
  // a top-level doc is declared relative to the framework document, and kept under its path from the root
  const inRoot = path.resolve(context.root, ref);
  for (const doc of context.framework.topLevel) {
    const file = path.resolve(path.dirname(context.framework.file), doc.path);
    const rel = path.relative(context.root, file).split(path.sep).join('/');
    if (file !== asPath && file !== inRoot && rel.toLowerCase() !== wanted) continue;
    if (!existsSync(file)) throw new ProviderError(`The top-level doc ${rel} is declared and has no file yet.`, null);
    const parsed = parse(readFileSync(file, 'utf8'), path.basename(file, '.md'), doc.title);
    return { key: rel, rel, title: parsed.title, kind: 'doc', message: provider.render(parsed), plain: plainText(parsed) };
  }
  throw new ProviderError(`${ref} is not a blueprint or a top-level doc of this root. Only those publish.`, null);
}

const sizeOf = (provider: Provider, message: string): number => (provider.limitUnit === 'bytes' ? Buffer.byteLength(message, 'utf8') : message.length);

// The decision, from the root and this machine alone (REQ5): what a dry run prints and what a publish carries out.
export function planFor(host: Host, provider: Provider, ref: string, name: string, options: PlanOptions = {}): Plan {
  const file = openFile(host, provider, ref);
  const destination = destinationNamed(host, provider, name);
  const sent = readPublished(host)[file.key]?.[destination.name];
  const size = sizeOf(provider, file.message);
  const base = { file: file.key, title: file.title, destination: destination.name, message: file.message, size, limit: provider.limit, reply: null, url: sent?.url ?? null };
  if (size > provider.limit) {
    const count = (value: number): string => `${value.toLocaleString('en-US')} ${provider.limitUnit}`;
    return { ...base, action: 'refused', reason: `The message is ${count(size)} and ${provider.service} allows ${count(provider.limit)}, so nothing is sent. Shorten the file.` };
  }
  if (!sent) return { ...base, action: 'post', reason: 'It has not been published here yet.' };
  if (sent.channel !== destination.key) return { ...base, action: 'post', url: null, reason: `${destination.name} now points at another channel, so it takes a new message.` };
  const current = sent.digest === digest(file.message);
  if (current && !options.force) return { ...base, action: 'none', reason: 'The message already matches the file.' };
  const account = provider.account();
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
  const file = openFile(host, provider, ref);
  const destination = destinationNamed(host, provider, name);
  const done = { file: plan.file, destination: plan.destination, reason: plan.reason };
  if (plan.action === 'refused') throw new ProviderError(`${plan.destination}: ${plan.file}: ${plan.reason}`, null);
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
    await record(host, file.key, destination.name, { message_id: id, channel: destination.key, url, digest: digest(file.message), text: packText(file.plain), at: new Date().toISOString(), by });
    host.emit('changed', { file: file.key, destination: destination.name });
  };
  const postNew = async (outcome: 'posted' | 'reposted' | 'replaced', reason: string): Promise<Done> => {
    let posted;
    try {
      posted = await sender.post(destination, file.message);
    } catch (cause) {
      throw failure(plan, cause);
    }
    await keep(posted.id, posted.url);
    return { ...done, outcome, reason, message_id: posted.id, url: posted.url, replied: false };
  };
  if (plan.action === 'post') return postNew('posted', plan.reason);
  if (plan.action === 'repost') return postNew('reposted', plan.reason);
  const message = sent!;
  try {
    await sender.edit(destination, message.message_id, file.message);
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
