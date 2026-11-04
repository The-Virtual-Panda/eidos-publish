// The plugin end to end in a sandbox the testing kit makes: `eidos teams` run
// as a person would, and the app's routes as the page calls them, against the
// fake Microsoft.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { pluginSandbox, type PluginSandbox } from 'eidosmd/plugin-testing';
import { ACCESS, REFRESH, REFRESH_ROTATED, startFakeMicrosoft, type FakeMicrosoft } from './fake-microsoft.ts';

const LINK = 'https://teams.microsoft.com/l/channel/19%3Aabc%40thread.tacv2/General?groupId=11111111-2222-3333-4444-555555555555&tenantId=66666666-7777-8888-9999-000000000000';
const OTHER = 'https://teams.microsoft.com/l/channel/19%3Aother%40thread.tacv2/Other?groupId=11111111-2222-3333-4444-555555555555';
const DOC = 'OVERVIEW.md';

let sandbox: PluginSandbox;
let fake: FakeMicrosoft;
let env: Record<string, string>;
let n = 0;

const run = (args: string[]) => sandbox.run(['teams', ...args], { env });
const ok = async (args: string[]): Promise<string> => {
  const result = await run(args);
  assert.equal(result.status, 0, `eidos teams ${args.join(' ')}\n${result.stderr}${result.stdout}`);
  return result.stdout;
};
const published = (): string => readFileSync(path.join(sandbox.root, '.eidos/plugins/teams/published.yaml'), 'utf8');
const credentials = (): string => path.join(sandbox.appData, 'plugins/teams/credentials.json');
const writeDoc = (text: string): void => writeFileSync(path.join(sandbox.root, DOC), text);
const signIn = async (edit: boolean): Promise<void> => {
  await ok(['login', ...(edit ? ['--edit'] : [])]);
};
// each test publishes to a destination of its own, so none sees another's record
const destination = async (): Promise<string> => {
  const name = `dest-${(n += 1)}`;
  await ok(['connect', name, '--channel', LINK]);
  return name;
};

before(async () => {
  fake = await startFakeMicrosoft();
  env = { EIDOS_TEAMS_LOGIN_BASE: fake.address, EIDOS_TEAMS_GRAPH_BASE: fake.address };
  Object.assign(process.env, env);
  sandbox = await pluginSandbox('plugins/teams/dist');
  const framework = path.join(sandbox.root, '.eidos/Framework.yaml');
  const text = readFileSync(framework, 'utf8');
  writeFileSync(framework, `${text.replace(/^top_level:.*\n(?:[ -].*\n)*/m, '')}top_level:\n  - title: Overview\n    path: ../${DOC}\n    description: The overview\n`);
  writeDoc('# Overview\n\nFirst words.\n');
});
after(async () => {
  await sandbox.close();
  await fake.close();
});
beforeEach(() => {
  fake.graph.length = 0;
  fake.failNext.length = 0;
  fake.pollAnswers.length = 0;
  writeDoc('# Overview\n\nFirst words.\n');
});

test('REQ2: a destination is added by its link and shared in the settings, and a bad one is refused', async () => {
  const name = await destination();
  const settings = readFileSync(path.join(sandbox.root, '.eidos/plugins/teams/settings.yaml'), 'utf8');
  assert.match(settings, /19:abc@thread\.tacv2/);
  assert.equal((await run(['connect', name, '--channel', LINK])).status, 1);
  const bad = await run(['connect', 'bad', '--channel', 'https://example.com']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Get link to channel/);
});

test('REQ2: a channel needs only its link, and a name of any words is made fit', async () => {
  const before = (await sandbox.route<{ destinations: Array<{ name: string }> }>('GET', 'state')).destinations.map((held) => held.name);
  const link = (id: string, title: string): string => `https://teams.microsoft.com/l/channel/19%3A${id}%40thread.tacv2/${encodeURIComponent(title)}?groupId=11111111-2222-3333-4444-555555555555`;
  const first = await sandbox.route<{ name: string; channel_name: string }>('POST', 'connect', { body: { link: link('one', 'Eidos Publish Testing') } });
  assert.equal(first.name, 'eidos-publish-testing');
  assert.equal(first.channel_name, 'Eidos Publish Testing');
  await assert.rejects(sandbox.route('POST', 'connect', { body: { link: link('one', 'Eidos Publish Testing') } }), /already added, as Eidos Publish Testing/);
  const sameTitle = await sandbox.route<{ name: string }>('POST', 'connect', { body: { link: link('two', 'Eidos Publish Testing') } });
  assert.equal(sameTitle.name, 'eidos-publish-testing-2');
  assert.equal((JSON.parse(await ok(['connect', 'Team Updates!', '--channel', link('three', 'General'), '--json'])) as { name: string }).name, 'team-updates');
  assert.match(await ok(['connect', '--channel', link('four', 'General')]), /Added general, the General channel/);
  for (const name of ['eidos-publish-testing', 'eidos-publish-testing-2', 'team-updates', 'general']) await ok(['disconnect', name]);
  assert.deepEqual((await sandbox.route<{ destinations: Array<{ name: string }> }>('GET', 'state')).destinations.map((held) => held.name), before);
});

test('the page reads and writes its settings in words, and a local one stays local', async () => {
  const defaults = await sandbox.route<{ reply: boolean; reply_min_chars: number }>('GET', 'options');
  assert.equal(defaults.reply, true);
  assert.equal(defaults.reply_min_chars, 120);
  const changed = await sandbox.route<{ reply: boolean; reply_min_chars: number }>('POST', 'options', { body: { name: 'reply_min_chars', value: '40' } });
  assert.equal(changed.reply_min_chars, 40);
  assert.equal((await sandbox.route<{ reply: boolean }>('POST', 'options', { body: { name: 'reply', value: false } })).reply, false);
  await assert.rejects(sandbox.route('POST', 'options', { body: { name: 'reply_min_chars', value: 'lots' } }), /whole number/);
  await assert.rejects(sandbox.route('POST', 'options', { body: { name: 'destinations', value: [] } }), /no setting called/);
  await sandbox.route('POST', 'options', { body: { name: 'reply', value: true } });
  await sandbox.route('POST', 'options', { body: { name: 'reply_min_chars', value: 120 } });
});

test('a first post mentions who was chosen, an edit keeps them, and a reply names nobody', async () => {
  await signIn(true);
  const name = await destination();
  writeDoc('# Overview\n\nFirst words.\n');
  const found = await sandbox.route<Array<{ kind: string; id: string; name: string }>>('POST', 'mentions', { body: { destination: name, query: 'project' } });
  assert.deepEqual(found, [{ kind: 'tag', id: 'tag-1', name: 'Project Managers', scope: '11111111-2222-3333-4444-555555555555' }]);
  const people = await sandbox.route<Array<{ kind: string; name: string }>>('POST', 'mentions', { body: { destination: name, query: 'janelle' } });
  assert.deepEqual(people.map((held) => held.name), ['Janelle Reyes']);
  assert.doesNotMatch(fake.lookups.join(), /no consistency level/);
  fake.graph.length = 0;
  const chosen = [found[0], { kind: 'person', id: 'user-1', name: 'Janelle <Reyes>' }, { kind: 'channel', id: '19:abc@thread.tacv2', name: 'General' }];
  await sandbox.route('POST', 'publish', { body: { file: DOC, destination: name, mentions: chosen } });
  const posted = fake.graph[0]!.body;
  assert.equal(posted.body.content, '<h1>Overview</h1><p>First words.</p><p><at id="0">Project Managers</at> <at id="1">Janelle &lt;Reyes&gt;</at> <at id="2">General</at></p>');
  assert.deepEqual(posted.mentions?.map((held) => held.mentioned), [
    { tag: { id: 'tag-1', displayName: 'Project Managers' } },
    { user: { id: 'user-1', displayName: 'Janelle <Reyes>', userIdentityType: 'aadUser' } },
    { conversation: { id: '19:abc@thread.tacv2', displayName: 'General', conversationIdentityType: 'channel' } },
  ]);
  assert.equal((JSON.parse(await ok(['publish', DOC, '--to', name, '--dry-run', '--json'])) as { action: string }).action, 'none', 'who is mentioned is not a change to the file');

  fake.graph.length = 0;
  writeDoc(`# Overview\n\nFirst words.\n\n## New\n\n${'x'.repeat(200)}\n`);
  await ok(['publish', DOC, '--to', name]);
  assert.equal(fake.graph[0]?.method, 'PATCH');
  assert.equal(fake.graph[0]?.body.mentions?.length, 3, 'an edit that left them out would strip them');
  assert.match(fake.graph[1]?.path ?? '', /replies$/);
  assert.equal(fake.graph[1]?.body.mentions, undefined);

  writeDoc('# Overview\n\nFirst words.\n');
  await assert.rejects(run(['publish', DOC, '--to', name, '--mention', 'Nobody']).then((result) => (result.status === 0 ? null : Promise.reject(new Error(result.stderr)))), /Nobody/);
});

test('a project default starts each first post, can be changed, and leaves out a tag of another team', async () => {
  await signIn(true);
  const name = await destination();
  const [tag] = await sandbox.route<Array<{ kind: string; id: string; name: string; scope: string }>>('POST', 'mentions', { body: { query: 'project' } });
  assert.equal(tag?.scope, '11111111-2222-3333-4444-555555555555');
  const person = { kind: 'person', id: 'user-1', name: 'Janelle Reyes' };
  await sandbox.route('POST', 'options', { body: { name: 'default_mentions', value: [tag, person] } });
  writeDoc('# Overview\n\nFirst words.\n');
  const plan = await sandbox.route<{ first: { mentions: Array<{ name: string }> } }>('POST', 'plan', { body: { file: DOC, destination: name } });
  assert.deepEqual(plan.first.mentions.map((held) => held.name), ['Project Managers', 'Janelle Reyes']);

  const elsewhere = 'other-team';
  await ok(['connect', elsewhere, '--channel', 'https://teams.microsoft.com/l/channel/19%3Aelse%40thread.tacv2/Else?groupId=99999999-2222-3333-4444-555555555555']);
  const there = await sandbox.route<{ first: { mentions: Array<{ name: string }> } }>('POST', 'plan', { body: { file: DOC, destination: elsewhere } });
  assert.deepEqual(there.first.mentions.map((held) => held.name), ['Janelle Reyes'], 'the tag means nothing in another team');
  await ok(['disconnect', elsewhere]);

  fake.graph.length = 0;
  await sandbox.route('POST', 'publish', { body: { file: DOC, destination: name, mentions: [person] } });
  assert.equal(fake.graph[0]?.body.mentions?.length, 1, 'what the person chose wins');
  assert.equal((await sandbox.route<{ default_mentions: unknown[] }>('GET', 'options')).default_mentions.length, 2, 'changing it for one post leaves the default');
  await sandbox.route('POST', 'options', { body: { name: 'default_mentions', value: [] } });
});

test('a plain sign-in mentions people and the channel with no administrator, and tags come with the approval', async () => {
  await signIn(false);
  const name = await destination();
  const found = await sandbox.route<Array<{ kind: string; name: string }>>('POST', 'mentions', { body: { destination: name, query: 'project' } });
  assert.deepEqual(found, []);
  const people = await sandbox.route<Array<{ kind: string; name: string }>>('POST', 'mentions', { body: { destination: name, query: 'janelle' } });
  assert.deepEqual(people, [{ kind: 'person', id: 'user-1', name: 'Janelle Reyes' }]);
  const channel = await sandbox.route<Array<{ kind: string; name: string }>>('POST', 'mentions', { body: { destination: name, query: 'general' } });
  assert.equal(channel[0]?.kind, 'channel');
});

test('a first post shares the properties chosen, and later edits keep sharing them', async () => {
  await signIn(true);
  const name = await destination();
  writeDoc('---\ndate: 2026-08-12 14:00\nstatus: Draft\nowners: [Ada, Grace]\nnested: { a: 1 }\n---\n# Overview\n\nFirst words.\n');
  const plan = await sandbox.route<{ action: string; first: { properties: Array<{ name: string; label: string; value: string }>; chosen: string[] } }>('POST', 'plan', { body: { file: DOC, destination: name } });
  assert.deepEqual(plan.first.properties, [
    { name: 'date', label: 'Date', value: '2026-08-12 14:00' },
    { name: 'status', label: 'Status', value: 'Draft' },
    { name: 'owners', label: 'Owners', value: 'Ada, Grace' },
  ]);
  assert.deepEqual(plan.first.chosen, []);
  const chosen = await sandbox.route<{ message: string }>('POST', 'plan', { body: { file: DOC, destination: name, properties: ['date', 'owners'] } });
  assert.equal(chosen.message, '<h1>Overview</h1><p><strong>Date:</strong> 2026-08-12 14:00<br><strong>Owners:</strong> Ada, Grace</p><p>First words.</p>');
  fake.graph.length = 0;
  await sandbox.route('POST', 'publish', { body: { file: DOC, destination: name, properties: ['date', 'owners'] } });
  assert.match(fake.graph[0]?.body.body.content ?? '', /Date:<\/strong> 2026-08-12 14:00/);

  fake.graph.length = 0;
  writeDoc('---\ndate: 2026-08-13 09:00\nstatus: Final\nowners: [Ada, Grace]\n---\n# Overview\n\nFirst words.\n');
  const edit = await sandbox.route<{ action: string; first?: unknown; reply: string[]; message: string }>('POST', 'plan', { body: { file: DOC, destination: name } });
  assert.equal(edit.action, 'edit');
  assert.equal(edit.first, undefined, 'the choice is a first post\'s');
  assert.deepEqual(edit.reply, ['Date: 2026-08-12 14:00 → 2026-08-13 09:00']);
  assert.match(edit.message, /2026-08-13 09:00/);
  writeDoc('---\ndate: 2026-08-13 09:00\nstatus: Draft\nowners: [Ada, Grace]\n---\n# Overview\n\nFirst words.\n');
  writeDoc('# Overview\n\nFirst words.\n');
});

test('Automations can publish: the step runs anywhere and says it leaves the machine', async () => {
  await signIn(true);
  const name = await destination();
  writeDoc('# Overview\n\nFrom an automation.\n');
  const catalog = JSON.parse((await sandbox.run(['automations', 'catalog', '--json'], { env })).stdout) as { actions: Array<{ id: string; title: string; leaves: boolean; where: string; fields: Array<{ name: string; options?: string[] }> }> };
  const step = catalog.actions.find((held) => held.id === 'teams.publish');
  assert.equal(step?.title, 'Publish to Teams');
  assert.equal(step?.leaves, true);
  assert.equal(step?.where, 'anywhere');
  assert.ok(step?.fields.find((field) => field.name === 'channel')?.options?.includes(name));
  const file = path.join(sandbox.root, 'publish-automation.yaml');
  writeFileSync(file, `name: Send it\nwhen: { on: by-name }\nask: never\nsteps:\n  - do: teams.publish\n    channel: ${name}\n    file: ${DOC}\n`);
  const saved = await sandbox.run(['automations', 'save', '--file', file], { env });
  assert.equal(saved.status, 0, saved.stderr);
  const on = await sandbox.run(['automations', 'on', 'Send it'], { env });
  assert.equal(on.status, 0, on.stderr);
  fake.graph.length = 0;
  const running = await sandbox.run(['automations', 'run', 'Send it', '--json'], { env });
  assert.notEqual(running.stdout, '', running.stderr);
  const started = (JSON.parse(running.stdout) as { run: { n: number; state: string } }).run;
  assert.equal(started.state, 'waiting', 'the first run to leave this machine asks');
  assert.equal(fake.graph.length, 0);
  const answered = await sandbox.run(['automations', 'answer', String(started.n), 'continue'], { env });
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(fake.graph[0]?.method, 'POST');
  assert.match(published(), new RegExp(name));
});

test('REQ5: a dry run needs no sign-in and sends nothing', async () => {
  await ok(['logout']);
  const name = await destination();
  const plan = JSON.parse(await ok(['publish', DOC, '--to', name, '--dry-run', '--json'])) as { action: string; message: string; dry_run: boolean };
  assert.equal(plan.action, 'post');
  assert.equal(plan.message, '<h1>Overview</h1><p>First words.</p>');
  assert.equal(fake.graph.length, 0);
  assert.equal(existsSync(path.join(sandbox.root, '.eidos/plugins/teams/published.yaml')) && published().includes(name), false);
});

test('REQ12: a sign-in keeps its token in the owner-only file, and asks for only what was asked', async () => {
  await ok(['logout']);
  fake.forms.length = 0;
  fake.authorizes.length = 0;
  const said = await ok(['login']);
  assert.match(said, /Opening your browser/);
  assert.match(said, /posts a new message/);
  const asked = fake.authorizes[0];
  assert.equal(asked?.['code_challenge_method'], 'S256');
  assert.equal(asked?.['prompt'], 'select_account');
  assert.match(asked?.['redirect_uri'] ?? '', /^http:\/\/localhost:\d+$/);
  assert.equal('client_secret' in (fake.forms[0] ?? {}), false);
  const scope = fake.forms[0]?.['scope'] ?? '';
  assert.match(scope, /ChannelMessage\.Send/);
  assert.doesNotMatch(scope, /ReadWrite/);
  assert.match(scope, /offline_access/);
  const file = credentials();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { refresh_token: string }).refresh_token, REFRESH);
  fake.forms.length = 0;
  await signIn(true);
  assert.match(fake.forms[0]?.['scope'] ?? '', /ChannelMessage\.ReadWrite/);
  assert.match(await ok(['whoami']), /Ada Test, can edit messages/);
});

test('REQ12: --device signs in with a code for a machine with no browser', async () => {
  await ok(['logout']);
  fake.forms.length = 0;
  fake.pollAnswers.push({ status: 400, body: { error: 'authorization_pending' } });
  const said = await ok(['login', '--device']);
  assert.match(said, /ABCD-EFGH/);
  assert.match(fake.forms[0]?.['scope'] ?? '', /ChannelMessage\.Send/);
  assert.match(await ok(['whoami']), /Ada Test/);
});

test('REQ12: a device code the organization blocks says to sign in with the browser', async () => {
  await ok(['logout']);
  fake.pollAnswers.push({ status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS530035: Access has been blocked by security defaults' } });
  const result = await run(['login', '--device']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /blocks signing in with a code/);
  assert.match(result.stderr, /without --device/);
  assert.equal(existsSync(credentials()), false);
});

test('REQ13: a sign-in the organization refuses says so, with the address for the administrator', async () => {
  await ok(['logout']);
  fake.authorizeAnswers.push({ error: 'consent_required', error_description: 'AADSTS65001: The user or administrator has not consented' });
  const result = await run(['login', '--edit']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /organization has to approve/);
  assert.match(result.stderr, /adminconsent\?client_id=e1c53a47-293c-422b-a75c-4aaddfe910c7/);
  assert.match(result.stderr, /ChannelMessage\.ReadWrite/);
  assert.equal(existsSync(credentials()), false);
});

test('REQ4, REQ5, REQ6: post, nothing on no change, edit in place, and a reply past the threshold', async () => {
  await signIn(true);
  const name = await destination();
  const before = readFileSync(path.join(sandbox.root, DOC), 'utf8');
  const first = JSON.parse(await ok(['publish', DOC, '--to', name, '--json'])) as { outcome: string; message_id: string; url: string };
  assert.equal(first.outcome, 'posted');
  assert.equal(fake.graph[0]?.method, 'POST');
  assert.equal(fake.graph[0]?.path, `/v1.0/teams/11111111-2222-3333-4444-555555555555/channels/${encodeURIComponent('19:abc@thread.tacv2')}/messages`);
  assert.deepEqual(fake.graph[0]?.body, { body: { contentType: 'html', content: '<h1>Overview</h1><p>First words.</p>' } });
  assert.match(published(), new RegExp(first.message_id));
  assert.equal(readFileSync(path.join(sandbox.root, DOC), 'utf8'), before, 'the published file is never written');

  fake.graph.length = 0;
  assert.equal((JSON.parse(await ok(['publish', DOC, '--to', name, '--json'])) as { outcome: string }).outcome, 'unchanged');
  assert.equal(fake.graph.length, 0);

  writeDoc('# Overview\n\nFirst word.\n');
  const small = JSON.parse(await ok(['publish', DOC, '--to', name, '--json'])) as { outcome: string; replied: boolean };
  assert.deepEqual([small.outcome, small.replied], ['edited', false]);
  assert.deepEqual(
    fake.graph.map((request) => request.method),
    ['PATCH'],
  );
  assert.equal(fake.messages.get(first.message_id), '<h1>Overview</h1><p>First word.</p>');

  fake.graph.length = 0;
  writeDoc('# Overview\n\nFirst word.\n\n## New section\n\nMore.\n');
  const dry = JSON.parse(await ok(['publish', DOC, '--to', name, '--dry-run', '--json'])) as { action: string; reply: string[] };
  assert.equal(dry.action, 'edit');
  assert.deepEqual(dry.reply, ['Added: New section']);
  assert.equal(fake.graph.length, 0);
  const big = JSON.parse(await ok(['publish', DOC, '--to', name, '--json'])) as { replied: boolean };
  assert.equal(big.replied, true);
  assert.deepEqual(
    fake.graph.map((request) => request.method),
    ['PATCH', 'POST'],
  );
  assert.match(fake.graph[1]?.path ?? '', new RegExp(`/messages/${first.message_id}/replies$`));
  assert.equal(fake.graph[1]?.body.body.content, '<p><strong>Updated</strong></p><ul><li>Added: New section</li></ul>');
});

test('REQ5: --no-reply edits quietly, and --force edits an unchanged file', async () => {
  await signIn(true);
  const name = await destination();
  await ok(['publish', DOC, '--to', name]);
  fake.graph.length = 0;
  writeDoc('# Overview\n\nFirst words.\n\n## Another\n\nText.\n');
  await ok(['publish', DOC, '--to', name, '--no-reply']);
  assert.deepEqual(
    fake.graph.map((request) => request.method),
    ['PATCH'],
  );
  fake.graph.length = 0;
  assert.equal((JSON.parse(await ok(['publish', DOC, '--to', name, '--force', '--json'])) as { outcome: string; replied: boolean }).replied, false);
  assert.deepEqual(
    fake.graph.map((request) => request.method),
    ['PATCH'],
  );
});

test('REQ5: signed in without editing, a change posts a new message in place of the old, and says why', async () => {
  await signIn(false);
  const name = await destination();
  const first = JSON.parse(await ok(['publish', DOC, '--to', name, '--json'])) as { message_id: string };
  fake.graph.length = 0;
  writeDoc('# Overview\n\nOther words entirely.\n');
  const dry = JSON.parse(await ok(['publish', DOC, '--to', name, '--dry-run', '--json'])) as { action: string; reason: string };
  assert.equal(dry.action, 'repost');
  assert.match(dry.reason, /cannot edit/);
  const again = JSON.parse(await ok(['publish', DOC, '--to', name, '--json'])) as { outcome: string; message_id: string; replied: boolean };
  assert.equal(again.outcome, 'reposted');
  assert.notEqual(again.message_id, first.message_id);
  assert.deepEqual(
    fake.graph.map((request) => request.method),
    ['POST'],
  );
  assert.match(published(), new RegExp(again.message_id));
  assert.equal(new RegExp(`message_id: ${first.message_id}\\n`).test(published()), false);
});

test('REQ8: a deleted message is replaced and recorded', async () => {
  await signIn(true);
  const name = await destination();
  await ok(['publish', DOC, '--to', name]);
  writeDoc('# Overview\n\nChanged.\n');
  fake.failNext.push({ status: 404 });
  const done = JSON.parse(await ok(['publish', DOC, '--to', name, '--json'])) as { outcome: string; message_id: string };
  assert.equal(done.outcome, 'replaced');
  assert.match(published(), new RegExp(`message_id: ${done.message_id}\\n`));
});

test("REQ5: another person's message is warned about, and a second message goes only when confirmed", async () => {
  await signIn(true);
  const name = await destination();
  await ok(['publish', DOC, '--to', name]);
  const file = path.join(sandbox.root, '.eidos/plugins/teams/published.yaml');
  const theirs = readFileSync(file, 'utf8').replace(new RegExp(`(${name}:[\\s\\S]*?by: ).*`), '$1janelle');
  writeFileSync(file, theirs);
  fake.graph.length = 0;

  assert.equal((JSON.parse(await ok(['publish', DOC, '--to', name, '--dry-run', '--json'])) as { action: string }).action, 'none', 'an unchanged file has nothing to warn about');
  writeDoc('# Overview\n\nSomeone else changed this.\n');
  for (const edit of [true, false]) {
    await signIn(edit);
    const plan = JSON.parse(await ok(['publish', DOC, '--to', name, '--dry-run', '--json'])) as { action: string; reason: string; posted_by_other: string };
    assert.equal(plan.action, 'repost');
    assert.equal(plan.posted_by_other, 'janelle');
    assert.match(plan.reason, /janelle posted this message/);
    assert.match(await ok(['publish', DOC, '--to', name, '--dry-run']), /asks you to confirm/);
    const unconfirmed = await run(['publish', DOC, '--to', name]);
    assert.equal(unconfirmed.status, 1);
    assert.match(unconfirmed.stderr, /--take-over/);
    await assert.rejects(sandbox.route('POST', 'publish', { body: { file: DOC, destination: name } }), /--take-over/);
  }
  assert.equal(fake.graph.length, 0, 'nothing reached Teams without the confirmation');
  assert.equal(readFileSync(file, 'utf8'), theirs, 'the record is untouched');

  const taken = JSON.parse(await ok(['publish', DOC, '--to', name, '--json', '--take-over'])) as { outcome: string };
  assert.equal(taken.outcome, 'reposted');
  assert.deepEqual(
    fake.graph.map((request) => request.method),
    ['POST'],
  );
  assert.doesNotMatch(readFileSync(file, 'utf8'), new RegExp(`${name}:[\\s\\S]*?by: janelle`));
  writeDoc('# Overview\n\nFirst words.\n');
});

test('REQ8, REQ21: a 403 and a 500 post nothing and record nothing, and say who and why', async () => {
  await signIn(true);
  const name = await destination();
  await ok(['publish', DOC, '--to', name]);
  const held = published();
  writeDoc('# Overview\n\nChanged.\n');
  for (const status of [403, 500]) {
    fake.graph.length = 0;
    fake.failNext.push({ status, message: 'no way' });
    const result = await run(['publish', DOC, '--to', name]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${name}: ${DOC}: Teams answered ${status}: no way`));
    assert.deepEqual(
      fake.graph.map((request) => request.method),
      ['PATCH'],
    );
    assert.equal(published(), held);
  }
});

test('REQ21: a 429 waits as Retry-After says and tries again, then fails without a duplicate', async () => {
  await signIn(true);
  const name = await destination();
  fake.failNext.push({ status: 429, retryAfter: '1' });
  await ok(['publish', DOC, '--to', name]);
  assert.deepEqual(
    fake.graph.map((request) => request.method),
    ['POST', 'POST'],
  );
  fake.graph.length = 0;
  writeDoc('# Overview\n\nChanged.\n');
  for (let i = 0; i < 5; i += 1) fake.failNext.push({ status: 429, retryAfter: '1' });
  const result = await run(['publish', DOC, '--to', name]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /429/);
  assert.equal(
    fake.graph.every((request) => request.method === 'PATCH'),
    true,
  );
});

test('a reply that fails leaves the edit recorded, so the next publish sends nothing twice', async () => {
  await signIn(true);
  const name = await destination();
  await ok(['publish', DOC, '--to', name]);
  writeDoc('# Overview\n\nFirst words.\n\n## Added\n\nText.\n');
  fake.graph.length = 0;
  fake.failReplies = 1;
  const result = await run(['publish', DOC, '--to', name]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Edited/);
  assert.match(result.stdout, /reply did not send/);
  fake.graph.length = 0;
  assert.equal((JSON.parse(await ok(['publish', DOC, '--to', name, '--json'])) as { outcome: string }).outcome, 'unchanged');
  assert.equal(fake.graph.length, 0);
});

test('REQ19: a message over the limit is refused before anything is sent, with its size and the limit', async () => {
  await signIn(true);
  const name = await destination();
  writeDoc(`# Overview\n\n${'word '.repeat(6000)}\n`);
  fake.graph.length = 0;
  const dry = await run(['publish', DOC, '--to', name, '--dry-run']);
  assert.equal(dry.status, 1);
  assert.match(dry.stdout, /Refused/);
  const result = await run(['publish', DOC, '--to', name]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /30,0\d\d bytes and Teams allows 28,000/);
  assert.equal(fake.graph.length, 0);
});

test('REQ2: a destination moved to another channel takes a new message', async () => {
  await signIn(true);
  const name = await destination();
  await ok(['publish', DOC, '--to', name]);
  await ok(['disconnect', name]);
  await ok(['connect', name, '--channel', OTHER]);
  const plan = JSON.parse(await ok(['publish', DOC, '--to', name, '--dry-run', '--json'])) as { action: string };
  assert.equal(plan.action, 'post');
});

test('REQ9: status reads the root alone', async () => {
  await signIn(true);
  const name = await destination();
  await ok(['publish', DOC, '--to', name]);
  fake.graph.length = 0;
  fake.forms.length = 0;
  const row = (rows: Array<{ destination: string; state: string }>) => rows.find((held) => held.destination === name)?.state;
  assert.equal(row(JSON.parse(await ok(['status', '--json'])) as never), 'current');
  writeDoc('# Overview\n\nChanged.\n');
  assert.equal(row(JSON.parse(await ok(['status', name, '--json'])) as never), 'changed');
  assert.equal(fake.graph.length + fake.forms.length, 0);
});

test('REQ4: a blueprint publishes by its id, its file is never written, and its record follows eidos reid', async () => {
  await signIn(true);
  const name = await destination();
  const added = await sandbox.run(['configure:collection', 'add', 'Specs', '--unit', 'spec', '--yes'], { env });
  assert.equal(added.status, 0, added.stderr);
  const made = await sandbox.run(['new', 'specs', 'A Spec', '--json'], { env });
  assert.equal(made.status, 0, made.stderr);
  const listed = JSON.parse((await sandbox.run(['list', '--json'], { env })).stdout) as Array<{ id: string; path: string }>;
  const blueprint = listed[0]!;
  const file = path.resolve(sandbox.root, blueprint.path);
  const before = readFileSync(file, 'utf8');
  const done = JSON.parse(await ok(['publish', blueprint.id, '--to', name, '--json'])) as { file: string; outcome: string };
  assert.deepEqual([done.file, done.outcome], [blueprint.id, 'posted']);
  assert.match(fake.graph.at(-1)?.body.body.content ?? '', /^<h1>A Spec<\/h1>/);
  assert.doesNotMatch(fake.graph.at(-1)?.body.body.content ?? '', /B-|variant:/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.match(published(), new RegExp(`${blueprint.id}:`));
  const moved = await sandbox.run(['reid', `@${blueprint.id}`, '--yes'], { env });
  assert.equal(moved.status, 0, moved.stderr + moved.stdout);
  const renewed = (JSON.parse((await sandbox.run(['list', '--json'], { env })).stdout) as Array<{ id: string }>)[0]!.id;
  assert.notEqual(renewed, blueprint.id);
  assert.doesNotMatch(published(), new RegExp(`${blueprint.id}:`));
  assert.match(published(), new RegExp(`${renewed}:`));
  fake.graph.length = 0;
  assert.equal((JSON.parse(await ok(['publish', renewed, '--to', name, '--json'])) as { outcome: string }).outcome, 'unchanged');
  assert.equal(fake.graph.length, 0);
});

test('REQ3: only a blueprint or a top-level doc publishes', async () => {
  const name = await destination();
  const result = await run(['publish', 'README.md', '--to', name, '--dry-run']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a blueprint or a top-level doc/);
});

test('REQ20: no token reaches output, the settings, or the root, and a rotated refresh token is kept', async () => {
  await signIn(true);
  const name = await destination();
  const output = [await ok(['publish', DOC, '--to', name, '--json']), await ok(['whoami', '--json']), await ok(['status', '--json'])].join('');
  const held = JSON.parse(readFileSync(credentials(), 'utf8')) as { refresh_token: string };
  assert.equal(held.refresh_token, REFRESH_ROTATED);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const root = walk(sandbox.root)
    .map((file) => readFileSync(file, 'utf8'))
    .join('');
  for (const secret of [ACCESS, REFRESH, REFRESH_ROTATED]) {
    assert.equal(output.includes(secret), false);
    assert.equal(root.includes(secret), false);
  }
});

test('the page publishes through the same code, and a route never answers a token', async () => {
  await signIn(true);
  const name = await destination();
  const state = await sandbox.route<{ destinations: Array<{ name: string }>; account: { can_edit: boolean } }>('GET', 'state');
  assert.equal(state.account.can_edit, true);
  assert.equal(
    state.destinations.some((held) => held.name === name),
    true,
  );
  const plan = await sandbox.route<{ action: string }>('POST', 'plan', { body: { file: DOC, destination: name } });
  assert.equal(plan.action, 'post');
  await sandbox.route('POST', 'publish', { body: { file: DOC, destination: name } });
  const standing = await sandbox.route<{ rows: Array<{ destination: string; state: string; url: string | null }> }>('GET', 'standing', { query: { file: DOC } });
  const row = standing.rows.find((held) => held.destination === name);
  assert.equal(row?.state, 'current');
  assert.match(row?.url ?? '', /teams\.microsoft\.com/);
  assert.equal(JSON.stringify([state, plan, standing]).includes('fake-'), false);
});

test('the page starts a sign-in with the address alone in the answer, and a refusal is shown whole', async () => {
  const start = await sandbox.route<Record<string, unknown>>('POST', 'login/start', { body: { edit: true } });
  assert.match(String(start['address']), /\/oauth2\/v2\.0\/authorize\?/);
  assert.equal('code_verifier' in start, false);
  assert.equal((await sandbox.route<{ state: string }>('POST', 'login/poll')).state, 'pending');
  fake.authorizeAnswers.push({ error: 'access_denied', error_description: 'AADSTS65004: User declined to consent' });
  await fetch(String(start['address']));
  const poll = await sandbox.route<{ state: string; address: string }>('POST', 'login/poll');
  assert.equal(poll.state, 'refused');
  assert.match(poll.address, /adminconsent/);
});
