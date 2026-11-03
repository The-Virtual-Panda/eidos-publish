// What a publish does (Publish REQ3 to REQ9, REQ19): where a file stands against
// the message last sent to a destination, the decision that follows, and carrying
// it out. What was sent is kept in `published.yaml`, shared with the root and
// written here alone, by blueprint id or a top-level doc's path and by destination.
// The published file is never written.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Host } from 'eidosmd/plugin';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { changeBetween, replyHtml, replyLines, worthReplying } from './change.ts';
import { canEdit, graph, ProviderError, refresh, TEAMS_LIMIT_BYTES, type Sign } from './microsoft.ts';
import { digest, parse, plainText, teamsHtml } from './render.ts';
import { keepTeamsSignIn, teamsSignIn } from './tokens.ts';

export interface Destination {
  name: string;
  provider: 'teams';
  team: string;
  channel: string;
  channel_name: string;
  tenant: string | null;
}

export interface Sent {
  message_id: string;
  team: string;
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
  html: string;
  plain: string;
}

export type Action = 'post' | 'edit' | 'repost' | 'none' | 'refused';

export interface Plan {
  file: string;
  title: string;
  destination: string;
  provider: 'teams';
  action: Action;
  reason: string;
  message: string;
  bytes: number;
  limit: number;
  reply: string[] | null;
  url: string | null;
}

export interface Done {
  file: string;
  destination: string;
  provider: 'teams';
  // `replaced`: the message was gone, so a new one took its place
  outcome: 'posted' | 'edited' | 'reposted' | 'replaced' | 'unchanged';
  reason: string;
  message_id: string | null;
  url: string | null;
  replied: boolean;
  reply_error?: string;
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
const writePublishedText = (files: Published): string => `# What was published where, written by the Publish to Channels plugin; never edit it.\n${stringifyYaml({ files }, { lineWidth: 0 })}`;

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

export function destinationNamed(host: Host, name: string): Destination {
  const found = destinations(host).find((destination) => destination.name.toLowerCase() === name.trim().toLowerCase());
  if (found) return found;
  const names = destinations(host).map((destination) => destination.name);
  throw new ProviderError(`There is no destination called ${name}. ${names.length > 0 ? `This root has: ${names.join(', ')}.` : 'Add one with `eidos channels connect`.'}`, null);
}

// A blueprint by its id or path, or a top-level doc by its path: nothing else publishes.
export function openFile(host: Host, ref: string): OpenFile {
  const context = host.context();
  const asPath = path.resolve(context.cwd, ref);
  const wanted = ref.trim().toLowerCase();
  const blueprint = context.blueprints.find((held) => path.resolve(held.path) === asPath || held.rel.toLowerCase() === wanted || String(held.properties?.['id'] ?? '').toLowerCase() === wanted);
  if (blueprint) {
    const id = blueprint.properties?.['id'];
    const title = blueprint.properties?.['title'];
    const parsed = parse(readFileSync(blueprint.path, 'utf8'), blueprint.stem, typeof title === 'string' ? title : undefined);
    return { key: typeof id === 'string' && id ? id : blueprint.rel, rel: blueprint.rel, title: parsed.title, kind: 'blueprint', html: teamsHtml(parsed), plain: plainText(parsed) };
  }
  // a top-level doc is declared relative to the framework document, and kept under its path from the root
  const inRoot = path.resolve(context.root, ref);
  for (const doc of context.framework.topLevel) {
    const file = path.resolve(path.dirname(context.framework.file), doc.path);
    const rel = path.relative(context.root, file).split(path.sep).join('/');
    if (file !== asPath && file !== inRoot && rel.toLowerCase() !== wanted) continue;
    if (!existsSync(file)) throw new ProviderError(`The top-level doc ${rel} is declared and has no file yet.`, null);
    const parsed = parse(readFileSync(file, 'utf8'), path.basename(file, '.md'), doc.title);
    return { key: rel, rel, title: parsed.title, kind: 'doc', html: teamsHtml(parsed), plain: plainText(parsed) };
  }
  throw new ProviderError(`${ref} is not a blueprint or a top-level doc of this root. Only those publish.`, null);
}

export interface PlanOptions {
  force?: boolean;
  noReply?: boolean;
}

const sameChannel = (sent: Sent, destination: Destination): boolean => sent.team === destination.team && sent.channel === destination.channel;

// The decision, from the root and this machine alone (REQ5): what a dry run prints and what a publish carries out.
export function planFor(host: Host, ref: string, name: string, options: PlanOptions = {}): Plan {
  const file = openFile(host, ref);
  const destination = destinationNamed(host, name);
  const sent = readPublished(host)[file.key]?.[destination.name];
  const bytes = Buffer.byteLength(file.html, 'utf8');
  const base = {
    file: file.key,
    title: file.title,
    destination: destination.name,
    provider: destination.provider,
    message: file.html,
    bytes,
    limit: TEAMS_LIMIT_BYTES,
    reply: null,
    url: sent?.url ?? null,
  };
  if (bytes > TEAMS_LIMIT_BYTES)
    return {
      ...base,
      action: 'refused',
      reason: `The message is ${bytes.toLocaleString('en-US')} bytes and Teams allows ${TEAMS_LIMIT_BYTES.toLocaleString('en-US')}, so nothing is sent. Shorten the file.`,
    };
  if (!sent) return { ...base, action: 'post', reason: 'It has not been published here yet.' };
  if (!sameChannel(sent, destination)) return { ...base, action: 'post', url: null, reason: `${destination.name} now points at another channel, so it takes a new message.` };
  const current = sent.digest === digest(file.html);
  if (current && !options.force) return { ...base, action: 'none', reason: 'The message already matches the file.' };
  const signedIn = teamsSignIn();
  if (signedIn && !canEdit(signedIn.scopes))
    return {
      ...base,
      action: 'repost',
      reason: 'Your sign-in cannot edit messages, so this posts a new one and the old one stays. Run `eidos channels login teams --edit` to edit in place; your administrator must approve it.',
    };
  const before = unpackText(sent.text);
  const change = before === null ? null : changeBetween(before, file.plain);
  const settings = host.settings();
  const replying = change !== null && !current && !options.noReply && settings.get<boolean>('reply') !== false && worthReplying(change, Number(settings.get<number>('reply_min_chars') ?? 120));
  const reason = current ? 'The file did not change; --force edits the message anyway.' : 'The file changed since the last publish.';
  return { ...base, action: 'edit', reason: signedIn ? reason : `${reason} Sign in with \`eidos channels login teams --edit\` to send it.`, reply: replying && change ? replyLines(change) : null };
}

export function signFor(host: Host, permissions: string[], clientId: string): Sign {
  const settings = host.settings();
  const tenant = String(settings.get<string>('tenant') ?? '').trim();
  const known = destinations(host).find((destination) => destination.tenant)?.tenant;
  return { clientId, tenant: tenant || 'organizations', permissions, ...(tenant || !known ? {} : { consentTenant: known }) };
}

async function accessToken(host: Host, clientId: string): Promise<string> {
  const held = teamsSignIn();
  if (!held) throw new ProviderError('You are not signed in to Teams. Run `eidos channels login teams`.', null);
  if (held.client_id !== clientId) throw new ProviderError('This root now signs in with another Entra app. Run `eidos channels login teams` again.', null);
  const tokens = await refresh(signFor(host, held.scopes, clientId), held.refresh_token);
  if (tokens.refresh_token !== held.refresh_token) keepTeamsSignIn({ ...held, refresh_token: tokens.refresh_token });
  return tokens.access_token;
}

// A failure names the destination, the file, and what the provider said (REQ21).
const failure = (plan: Plan, cause: unknown, hint = ''): Error => {
  const said = cause instanceof Error ? cause.message : String(cause);
  const error = new ProviderError(`${plan.destination}: ${plan.file}: ${said}${hint}`, cause instanceof ProviderError ? cause.status : null);
  return error;
};

// Carried out as planned. What an edit's failure means decides what happens
// (REQ8): the message gone takes a replacement; a lost permission, a throttle,
// or an outage changes nothing and posts nothing. A message is recorded as soon
// as it is sent, so a reply that fails afterwards never posts it a second time.
export async function carryOut(host: Host, ref: string, name: string, clientId: string, options: PlanOptions = {}): Promise<Done> {
  const plan = planFor(host, ref, name, options);
  const file = openFile(host, ref);
  const destination = destinationNamed(host, name);
  const done = { file: plan.file, destination: plan.destination, provider: plan.provider, reason: plan.reason };
  if (plan.action === 'refused') throw new ProviderError(`${plan.destination}: ${plan.file}: ${plan.reason}`, null);
  const sent = readPublished(host)[file.key]?.[destination.name];
  if (plan.action === 'none') return { ...done, outcome: 'unchanged', message_id: sent?.message_id ?? null, url: sent?.url ?? null, replied: false };
  let client;
  try {
    client = graph(await accessToken(host, clientId));
  } catch (cause) {
    throw cause instanceof ProviderError ? failure(plan, cause) : cause;
  }
  const by = host.actingUser()?.alias ?? teamsSignIn()?.username ?? '';
  const keep = async (id: string, url: string | null): Promise<void> => {
    await record(host, file.key, destination.name, {
      message_id: id,
      team: destination.team,
      channel: destination.channel,
      url,
      digest: digest(file.html),
      text: packText(file.plain),
      at: new Date().toISOString(),
      by,
    });
    host.emit('changed', { file: file.key, destination: destination.name });
  };
  const postNew = async (outcome: 'posted' | 'reposted' | 'replaced', reason: string): Promise<Done> => {
    let posted;
    try {
      posted = await client.post(destination, file.html);
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
    await client.edit(destination, message.message_id, file.html);
  } catch (cause) {
    const status = cause instanceof ProviderError ? cause.status : null;
    if (status === 404 || status === 410) return postNew('replaced', 'The message was gone from Teams, so a new one took its place.');
    const someoneElse = status === 403 && message.by && message.by !== by ? ` The message was posted by ${message.by}; only they may be able to edit it.` : '';
    throw failure(plan, cause, someoneElse);
  }
  await keep(message.message_id, message.url);
  const edited: Done = { ...done, outcome: 'edited', message_id: message.message_id, url: message.url, replied: false };
  if (plan.reply === null) return edited;
  const change = changeBetween(unpackText(message.text) ?? '', file.plain);
  try {
    await client.reply(destination, message.message_id, replyHtml(change));
    return { ...edited, replied: true };
  } catch (cause) {
    return { ...edited, reply_error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export interface StatusRow {
  file: string;
  destination: string;
  provider: 'teams';
  state: 'current' | 'changed' | 'missing';
  at: string;
  by: string;
  url: string | null;
}

// From the root alone (REQ9): no request, no sign-in.
export function statusRows(host: Host, only?: string): StatusRow[] {
  const rows: StatusRow[] = [];
  for (const [key, held] of Object.entries(readPublished(host))) {
    let html: string | null = null;
    try {
      html = openFile(host, key).html;
    } catch {
      // the file left the root: its message stays and stops being edited
    }
    for (const [name, sent] of Object.entries(held)) {
      if (only && name.toLowerCase() !== only.trim().toLowerCase()) continue;
      rows.push({ file: key, destination: name, provider: 'teams', state: html === null ? 'missing' : digest(html) === sent.digest ? 'current' : 'changed', at: sent.at, by: sent.by, url: sent.url });
    }
  }
  return rows;
}
