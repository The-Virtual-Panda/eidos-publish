// The Slack plugin end to end in a sandbox the testing kit makes: `eidos slack` run
// as a person would, and the app's routes as the page calls them, against the fake Slack.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { pluginSandbox, type PluginSandbox } from 'eidosmd/plugin-testing';
import { startFakeSlack, TOKEN, type FakeSlack } from './fake-slack.ts';

const DOC = 'OVERVIEW.md';
const CHANNEL = 'C0123ABCDE';

let sandbox: PluginSandbox;
let fake: FakeSlack;
let env: Record<string, string>;
let n = 0;

const run = (args: string[], input?: string) => sandbox.run(['slack', ...args], { env, ...(input === undefined ? {} : { input }) });
const ok = async (args: string[], input?: string): Promise<string> => {
  const result = await run(args, input);
  assert.equal(result.status, 0, `eidos slack ${args.join(' ')}\n${result.stderr}${result.stdout}`);
  return result.stdout;
};
const methods = (): string[] => fake.calls.map((call) => call.method);
const published = (): string => readFileSync(path.join(sandbox.root, '.eidos/plugins/slack/published.yaml'), 'utf8');
const credentialsFile = (): string => path.join(sandbox.appData, 'plugins/slack/credentials.json');
const writeDoc = (text: string): void => writeFileSync(path.join(sandbox.root, DOC), text);
const destination = async (): Promise<string> => {
  const name = `dest-${(n += 1)}`;
  await ok(['connect', name, '--channel', `https://acme.slack.com/archives/${CHANNEL}`]);
  return name;
};
const publish = async (name: string, ...more: string[]): Promise<{ outcome: string; message_id: string; url: string; replied: boolean }> =>
  JSON.parse(await ok(['publish', DOC, '--to', name, '--json', ...more])) as never;

before(async () => {
  fake = await startFakeSlack();
  env = { EIDOS_SLACK_BASE: fake.address };
  Object.assign(process.env, env);
  sandbox = await pluginSandbox('plugins/slack/dist');
  const framework = path.join(sandbox.root, '.eidos/Framework.yaml');
  const text = readFileSync(framework, 'utf8');
  writeFileSync(framework, `${text.replace(/^top_level:.*\n(?:[ -].*\n)*/m, '')}top_level:\n  - title: Overview\n    path: ../${DOC}\n    description: The overview\n`);
});
after(async () => {
  await sandbox.close();
  await fake.close();
});
beforeEach(async () => {
  fake.calls.length = 0;
  fake.failNext.length = 0;
  writeDoc('# Overview\n\nFirst words.\n');
  await ok(['login'], `${TOKEN}\n`);
  fake.calls.length = 0;
});

test('REQ14: a token is kept only once Slack accepts it, owner-only, and never printed', async () => {
  await ok(['logout']);
  const notBot = await run(['login'], 'xoxp-a-user-token\n');
  assert.equal(notBot.status, 1);
  assert.match(notBot.stderr, /xoxb-/);
  const refused = await run(['login'], 'xoxb-wrong\n');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /does not accept the token/);
  assert.equal(refused.stderr.includes('xoxb-wrong'), false);
  assert.equal(existsSync(credentialsFile()), false);
  const said = await ok(['login'], `${TOKEN}\n`);
  assert.match(said, /Signed in to Test Workspace, posts as eidos_publish/);
  assert.equal(said.includes(TOKEN), false);
  assert.equal(statSync(credentialsFile()).mode & 0o777, 0o600);
  assert.match(await ok(['whoami']), /Slack: Test Workspace, posts as eidos_publish/);
});

test('REQ5: a dry run needs no sign-in and sends nothing', async () => {
  await ok(['logout']);
  const name = await destination();
  const plan = JSON.parse(await ok(['publish', DOC, '--to', name, '--dry-run', '--json'])) as { action: string; message: string };
  assert.equal(plan.action, 'post');
  assert.equal(plan.message, '# Overview\n\nFirst words.');
  assert.equal(fake.calls.length, 0);
});

test('REQ4, REQ5, REQ6: post, nothing on no change, edit in place, and a reply past the threshold', async () => {
  const name = await destination();
  const first = await publish(name);
  assert.equal(first.outcome, 'posted');
  assert.match(first.url, new RegExp(`/archives/${CHANNEL}/p`));
  assert.deepEqual(methods(), ['chat.postMessage', 'chat.getPermalink']);
  assert.deepEqual(fake.calls[0]?.body, { channel: CHANNEL, markdown_text: '# Overview\n\nFirst words.', unfurl_links: false, unfurl_media: false });
  assert.match(published(), new RegExp(`message_id: "?${first.message_id}`));

  fake.calls.length = 0;
  assert.equal((await publish(name)).outcome, 'unchanged');
  assert.equal(fake.calls.length, 0);

  writeDoc('# Overview\n\nFirst word.\n');
  const small = await publish(name);
  assert.deepEqual([small.outcome, small.replied], ['edited', false]);
  assert.deepEqual(methods(), ['chat.update']);
  assert.deepEqual(fake.calls[0]?.body, { channel: CHANNEL, ts: first.message_id, markdown_text: '# Overview\n\nFirst word.', as_user: true });

  fake.calls.length = 0;
  writeDoc('# Overview\n\nFirst word.\n\n## New section\n\nMore.\n');
  const big = await publish(name);
  assert.equal(big.replied, true);
  assert.deepEqual(methods(), ['chat.update', 'chat.postMessage']);
  assert.deepEqual(fake.calls[1]?.body, { channel: CHANNEL, thread_ts: first.message_id, text: '*Updated*\n• Added: New section', unfurl_links: false, unfurl_media: false });
});

test('REQ8: a deleted message is replaced and recorded', async () => {
  const name = await destination();
  await publish(name);
  writeDoc('# Overview\n\nChanged.\n');
  fake.failNext.push({ method: 'chat.update', error: 'message_not_found' });
  const done = await publish(name);
  assert.equal(done.outcome, 'replaced');
  assert.match(published(), new RegExp(`message_id: "?${done.message_id}`));
});

test('REQ8, REQ21: a refusal and an outage post nothing and record nothing, and say who and why', async () => {
  const name = await destination();
  await publish(name);
  const held = published();
  writeDoc('# Overview\n\nChanged.\n');
  for (const [fail, said] of [
    [{ method: 'chat.update', error: 'not_in_channel' }, /not in this channel.*not_in_channel/],
    [{ method: 'chat.update', error: 'token_revoked' }, /revoked/],
    [{ method: 'chat.update', error: 'cant_update_message' }, /will not let the app edit/],
    [{ method: 'chat.update', status: 503 }, /503/],
  ] as const) {
    fake.calls.length = 0;
    fake.failNext.push(fail);
    const result = await run(['publish', DOC, '--to', name]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${name}: ${DOC}: `));
    assert.match(result.stderr, said);
    assert.deepEqual(methods(), ['chat.update']);
    assert.equal(published(), held);
  }
});

test('REQ21: a 429 waits as Retry-After says and tries again', async () => {
  const name = await destination();
  fake.failNext.push({ method: 'chat.postMessage', status: 429, retryAfter: '1' });
  await publish(name);
  assert.deepEqual(methods(), ['chat.postMessage', 'chat.postMessage', 'chat.getPermalink']);
});

test('a permalink that fails never fails a message that was sent', async () => {
  const name = await destination();
  fake.failNext.push({ method: 'chat.getPermalink', error: 'channel_not_found' });
  const done = await publish(name);
  assert.equal(done.outcome, 'posted');
  assert.equal(done.url, null);
});

test('a reply that fails leaves the edit recorded, so the next publish sends nothing twice', async () => {
  const name = await destination();
  await publish(name);
  writeDoc('# Overview\n\nFirst words.\n\n## Added\n\nText.\n');
  fake.failNext.push({ method: 'chat.postMessage', error: 'internal_error' });
  const result = await run(['publish', DOC, '--to', name]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Edited/);
  assert.match(result.stdout, /reply did not send/);
  fake.calls.length = 0;
  assert.equal((await publish(name)).outcome, 'unchanged');
  assert.equal(fake.calls.length, 0);
});

test('REQ19: a message over the limit is refused before anything is sent, with its size and the limit', async () => {
  const name = await destination();
  writeDoc(`# Overview\n\n${'word '.repeat(2500)}\n`);
  const result = await run(['publish', DOC, '--to', name]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /12,\d\d\d characters and Slack allows 12,000 characters/);
  assert.equal(fake.calls.length, 0);
});

test('REQ20: no token reaches output, the settings, or the root', async () => {
  const name = await destination();
  const output = [await ok(['publish', DOC, '--to', name, '--json']), await ok(['whoami', '--json']), await ok(['status', '--json'])].join('');
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const root = walk(sandbox.root)
    .map((file) => readFileSync(file, 'utf8'))
    .join('');
  assert.equal(output.includes(TOKEN), false);
  assert.equal(root.includes(TOKEN), false);
});

test('the page connects and publishes through the same code, and no route answers the token', async () => {
  await ok(['logout']);
  const name = await destination();
  const account = await sandbox.route<{ name: string; can_edit: boolean }>('POST', 'login', { body: { token: TOKEN } });
  assert.deepEqual([account.name, account.can_edit], ['Test Workspace', true]);
  const state = await sandbox.route('GET', 'state');
  const created = await sandbox.route<{ address: string }>('GET', 'create-app');
  assert.match(created.address, /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
  await sandbox.route('POST', 'publish', { body: { file: DOC, destination: name } });
  const standing = await sandbox.route<{ rows: Array<{ destination: string; state: string }> }>('GET', 'standing', { query: { file: DOC } });
  assert.equal(standing.rows.find((row) => row.destination === name)?.state, 'current');
  assert.equal(JSON.stringify([account, state, standing]).includes(TOKEN), false);
});
