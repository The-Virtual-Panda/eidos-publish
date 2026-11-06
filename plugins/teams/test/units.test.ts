// The pure parts on their own: exact Teams HTML, how a change is measured, and
// reading a channel's link.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeBetween, measure, replyLines, worthReplying } from '../../../packages/core/src/change.ts';
import { ProviderError } from '../../../packages/core/src/errors.ts';
import { parse, plainText } from '../../../packages/core/src/render.ts';
import { teamsHtml, teamsReply } from '../src/html.ts';
import { adminConsentAddress, canEdit, readChannelLink, startBrowserSignIn } from '../src/microsoft.ts';

const html = (markdown: string, title = 'Title'): string => teamsHtml(parse(markdown, 'fallback', title));

test('REQ7: the title opens the message, and frontmatter and a repeated heading are gone', () => {
  assert.equal(html('---\nid: B-1\ntitle: Title\n---\n\n# Title\n\nBody.\n'), '<h1>Title</h1><p>Body.</p>');
  assert.equal(teamsHtml(parse('# From the heading\n\nBody.', 'fallback')), '<h1>From the heading</h1><p>Body.</p>');
  assert.equal(teamsHtml(parse('Body.', 'fallback')), '<h1>fallback</h1><p>Body.</p>');
});

test('REQ16: emphasis, code, headings, and lists keep their shape', () => {
  assert.equal(html('## Two\n\n**b** *i* ~~s~~ `c<d`'), '<h1>Title</h1><h2>Two</h2><p><strong>b</strong> <em>i</em> <s>s</s> <code>c&lt;d</code></p>');
  assert.equal(html('```js\nif (a < b) {}\n```'), '<h1>Title</h1><pre><code>if (a &lt; b) {}</code></pre>');
  assert.equal(html('- one\n- two\n  - nested\n'), '<h1>Title</h1><ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>');
  assert.equal(html('3. three\n4. four\n'), '<h1>Title</h1><ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(html('> quoted'), '<h1>Title</h1><blockquote><p>quoted</p></blockquote>');
  assert.equal(html('a\n\n---\n\nb'), '<h1>Title</h1><p>a</p><hr><p>b</p>');
});

test('REQ16: a task list shows each box once', () => {
  assert.equal(html('- [x] done\n- [ ] open\n'), '<h1>Title</h1><ul><li>☑ done</li><li>☐ open</li></ul>');
});

test('REQ16: a table is a table', () => {
  assert.equal(html('| a | b |\n| - | - |\n| 1 | **2** |\n'), '<h1>Title</h1><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table>');
});

test('REQ16: hand-written HTML is shown as text, so it injects nothing and forges no mention', () => {
  assert.equal(html('<script>alert(1)</script>'), '<h1>Title</h1><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(html('Hi <at id="0">Ada</at>'), '<h1>Title</h1><p>Hi &lt;at id=&quot;0&quot;&gt;Ada&lt;/at&gt;</p>');
  assert.equal(html('A <img src=x onerror=y> b'), '<h1>Title</h1><p>A &lt;img src=x onerror=y&gt; b</p>');
  assert.equal(teamsHtml(parse('Body', 'x', '<b>Title</b>')), '<h1>&lt;b&gt;Title&lt;/b&gt;</h1><p>Body</p>');
});

test('REQ16: a comment and a region marker are dropped, and the region is rendered', () => {
  assert.equal(html('<!-- a note -->\n\nText <!-- inline --> more'), '<h1>Title</h1><p>Text  more</p>');
  assert.equal(html('<!-- backlog:tasks -->\n- [ ] in the region\n<!-- /backlog:tasks -->\n'), '<h1>Title</h1><ul><li>☐ in the region</li></ul>');
});

test('REQ16: only http, https, and mailto stay links; an image is its alt text', () => {
  assert.equal(html('[a](https://x.example/?a=1&b=2)'), '<h1>Title</h1><p><a href="https://x.example/?a=1&amp;b=2">a</a></p>');
  assert.equal(html('[m](mailto:a@x.example)'), '<h1>Title</h1><p><a href="mailto:a@x.example">m</a></p>');
  assert.equal(html('[spec](../other/spec.md)'), '<h1>Title</h1><p>spec</p>');
  assert.equal(html('[x](javascript:alert(1))'), '<h1>Title</h1><p>x</p>');
  assert.equal(html('[x](JaVaScRiPt:alert(1))'), '<h1>Title</h1><p>x</p>');
  assert.equal(html('![a diagram](./d.png)'), '<h1>Title</h1><p>a diagram</p>');
});

test('REQ6: a word fixed in a long paragraph counts as that word, not the paragraph', () => {
  const long = 'x'.repeat(500);
  assert.deepEqual(measure(`# T\n${long} teh end`, `# T\n${long} the end`), { added: 2, removed: 2 });
  assert.deepEqual(measure('a\nb', 'a\nb\nnew line'), { added: 8, removed: 0 });
  assert.deepEqual(measure('same', 'same'), { added: 0, removed: 0 });
});

test('REQ6: a change is big enough by its characters or by a heading', () => {
  const before = '# T\n\n## One\n\nFirst.\n\n## Two\n\nSecond.';
  const small = changeBetween(before, before.replace('First.', 'First!'));
  assert.deepEqual(small.sections_changed, ['One']);
  assert.equal(worthReplying(small, 120), false);
  assert.equal(worthReplying(changeBetween(before, before.replace('First.', 'y'.repeat(130))), 120), true);
  const renamed = changeBetween(before, before.replace('## Two', '## Second'));
  assert.deepEqual(renamed.sections_added, ['Second']);
  assert.deepEqual(renamed.sections_removed, ['Two']);
  assert.equal(worthReplying(renamed, 120), true);
});

test('REQ6: a reply names sections and is never a diff', () => {
  const change = { added_chars: 1, removed_chars: 1, sections_added: ['A'], sections_removed: [], items: [], properties_changed: [], sections_changed: ['C'] };
  assert.deepEqual(replyLines(change), ['Added: A', 'Changed: C']);
});

test('plain text keeps headings apart from a paragraph that opens with #', () => {
  assert.equal(plainText(parse('## Real\n\n\\# not a heading\n\n```\n# code\n```', 'x', 'T')), '# T\n## Real\n\\# not a heading\n    # code');
});

test('REQ2: a channel link gives the team and the channel', () => {
  const read = readChannelLink('https://teams.microsoft.com/l/channel/19%3Aabc123%40thread.tacv2/General?groupId=11111111-2222-3333-4444-555555555555&tenantId=66666666-7777-8888-9999-000000000000');
  assert.deepEqual(read, { team: '11111111-2222-3333-4444-555555555555', channel: '19:abc123@thread.tacv2', channel_name: 'General', tenant: '66666666-7777-8888-9999-000000000000' });
  for (const bad of [
    'nope',
    'https://example.com/l/channel/19%3Aa/G?groupId=11111111-2222-3333-4444-555555555555',
    'https://teams.microsoft.com/l/channel/19%3Aa/G',
    'https://teams.microsoft.com/l/team/19%3Aa/G?groupId=11111111-2222-3333-4444-555555555555',
  ])
    assert.throws(() => readChannelLink(bad), ProviderError);
});

test('REQ12: editing is known from the permissions Microsoft granted', () => {
  assert.equal(canEdit(['ChannelMessage.Send']), false);
  assert.equal(canEdit(['https://graph.microsoft.com/ChannelMessage.ReadWrite']), true);
});

test('REQ13: the admin consent address names the tenant, the app, and the permissions', () => {
  const url = new URL(adminConsentAddress('tenant-9', 'client-1', ['ChannelMessage.Send']));
  assert.equal(url.pathname, '/tenant-9/v2.0/adminconsent');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('scope'), 'https://graph.microsoft.com/ChannelMessage.Send');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://thevirtualpanda.com/eidos/teams-approved/');
});

test('REQ6: a reply names the list items and the shared properties that changed', () => {
  const change = changeBetween('# Sync\nDate: Monday\n## Agenda\n- Budget\n- Vendors', '# Sync\nDate: Tuesday\n## Agenda\n- Budget\n- Hiring');
  assert.deepEqual(change.items, [{ section: 'Agenda', added: ['Hiring'], removed: ['Vendors'], edited: [] }]);
  assert.deepEqual(change.properties_changed, ['Date: Monday → Tuesday']);
  assert.equal(worthReplying(change, 1000), true);
  assert.deepEqual(replyLines(change), ['Date: Monday → Tuesday', 'Changed: Agenda', '  Added: Hiring', '  Removed: Vendors']);
});

test('REQ26: each item sits under its section on its own line, however many there are', () => {
  const before = '# Sync\n## Decisions\n- Keep, for now, the old plan\n## Actions\n- Sam: Ship';
  const after = '# Sync\n## Decisions\n- Keep, for now, the old plan\n- Move, later, to weekly\n- Hire in spring\n## Actions\n- Sam: Ship\n- Kathey: Begin design';
  assert.deepEqual(replyLines(changeBetween(before, after)), ['Changed: Decisions', '  Added: Move, later, to weekly', '  Added: Hire in spring', 'Changed: Actions', '  Added: Kathey: Begin design']);
});

test('REQ26: an item edited in place is said once, as it now reads', () => {
  const kept = 'Tina: If investment transactions post early again, email us the exact steps taken.';
  const change = changeBetween(`# Recap\n## Actions\n- ${kept}- {Name}: {What they will do}`, `# Recap\n## Actions\n- ${kept}`);
  assert.deepEqual(change.items, [{ section: 'Actions', added: [], removed: [], edited: [kept] }]);
  assert.deepEqual(replyLines(change), ['Changed: Actions', `  Edited: ${kept}`]);
  const midway = changeBetween('# R\n## A\n- Harrison: Add investment transactions to the log', '# R\n## A\n- Harrison: Add all investment transactions to the log');
  assert.deepEqual(midway.items[0]?.edited, ['Harrison: Add all investment transactions to the log']);
});

test('REQ26: a replaced item stays one removed and one added', () => {
  const change = changeBetween('# R\n## A\n- Sam: Ship the deploy', '# R\n## A\n- Kathey: Write requirements');
  assert.deepEqual(change.items, [{ section: 'A', added: ['Kathey: Write requirements'], removed: ['Sam: Ship the deploy'], edited: [] }]);
});

test('REQ26: a small edit to an item is no reason to reply, and an added or removed item is', () => {
  const before = '# R\n## A\n- Ship the deploy on Friday';
  assert.equal(worthReplying(changeBetween(before, before.replace('Friday', 'Monday')), 120), false);
  assert.equal(worthReplying(changeBetween(before, `${before}\n- Hi`), 120), true);
  assert.equal(worthReplying(changeBetween(`${before}\n- Hi`, before), 120), true);
});

test('REQ26: a long item is cut at a word so a reply stays short', () => {
  const long = `Harrison: ${'investigate the records '.repeat(12)}`.trim();
  const [, item] = replyLines(changeBetween('# R\n## A\n- First', `# R\n## A\n- First\n- ${long}`));
  assert.ok((item ?? '').length <= 2 + 'Added: '.length + 141);
  assert.match(item ?? '', /^ {2}Added: Harrison: investigate.* records…$/);
});

test('REQ26: a new section is named without its items, and a moved item is not news', () => {
  assert.deepEqual(replyLines(changeBetween('# R\n## A\n- One', '# R\n## A\n- One\n## B\n- Two')), ['Added: B']);
  assert.deepEqual(replyLines(changeBetween('# R\n## A\n- One\n## B\n- Two', '# R\n## A\n## B\n- Two\n- One')), ['Changed: A', 'Changed: B']);
});

test('REQ25: a list item above the first heading is an item, not a shared property', () => {
  const change = changeBetween('# R\n- Sam: Ship', '# R\n- Kathey: Write');
  assert.deepEqual(change.properties_changed, []);
  assert.deepEqual(replyLines(change), ['Changed: R', '  Added: Kathey: Write', '  Removed: Sam: Ship']);
});

test('REQ26: a Teams reply nests the items and escapes them', () => {
  assert.equal(teamsReply(['Added: B', 'Changed: A <1>', '  Added: x & y', '  Edited: z', 'Changed: C']), '<p><strong>Updated</strong></p><ul><li>Added: B</li><li>Changed: A &lt;1&gt;<ul><li>Added: x &amp; y</li><li>Edited: z</li></ul></li><li>Changed: C</li></ul>');
});

test('REQ12: a request to the sign-in port without its state neither ends the sign-in nor is answered', async () => {
  const signIn = await startBrowserSignIn({ clientId: 'client-1', tenant: 'organizations', permissions: ['ChannelMessage.Send'] });
  const asked = new URL(signIn.address);
  assert.equal(asked.pathname, '/organizations/oauth2/v2.0/authorize');
  const port = new URL(asked.searchParams.get('redirect_uri') ?? '').port;
  const forged = await fetch(`http://127.0.0.1:${port}/?code=stolen&state=forged`);
  assert.equal(forged.status, 404);
  assert.deepEqual(signIn.poll(), { state: 'pending' });
  signIn.close();
});
