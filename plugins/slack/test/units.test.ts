// The Slack plugin's pure parts: the exact markdown it sends, and reading a channel.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../../packages/core/src/errors.ts';
import { parse } from '../../../packages/core/src/render.ts';
import { slackMarkdown, slackReply } from '../src/markdown.ts';
import { createAppAddress, readChannel } from '../src/slack.ts';

const md = (markdown: string): string => slackMarkdown(parse(markdown, 'fallback', 'Title'));

test('REQ7: the title opens the message, and frontmatter and a repeated heading are gone', () => {
  assert.equal(md('---\nid: B-1\n---\n\n# Title\n\nBody.\n'), '# Title\n\nBody.');
});

test('REQ16: emphasis, code, headings, and lists keep their shape', () => {
  assert.equal(md('## Two\n\n**b** *i* ~~s~~ `c`'), '# Title\n\n## Two\n\n**b** *i* ~~s~~ `c`');
  assert.equal(md('```js\nconst a = 1;\n```'), '# Title\n\n```\nconst a = 1;\n```');
  assert.equal(md('- one\n- two\n  - nested\n'), '# Title\n\n- one\n- two\n  - nested');
  assert.equal(md('3. three\n4. four\n'), '# Title\n\n3. three\n4. four');
  assert.equal(md('> quoted'), '# Title\n\n> quoted');
  assert.equal(md('a\n\n---\n\nb'), '# Title\n\na\n\n---\n\nb');
});

test('REQ16: a task list and a table are written so Slack renders them', () => {
  assert.equal(md('- [x] done\n- [ ] open\n'), '# Title\n\n- [x] done\n- [ ] open');
  assert.equal(md('| a | b |\n| - | - |\n| 1 | **2** |\n'), '# Title\n\n| a | b |\n| --- | --- |\n| 1 | **2** |');
});

test('REQ16: a file cannot forge a mention or a broadcast', () => {
  assert.equal(md('Hi <@U123> and <!channel>'), '# Title\n\nHi &lt;@U123&gt; and &lt;!channel&gt;');
  assert.equal(md('<script>alert(1)</script>'), '# Title\n\n&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(md('Tell @channel and @here'), '# Title\n\nTell @⁠channel and @⁠here');
  assert.equal(md('`<!channel>`'), '# Title\n\n`&lt;!channel&gt;`');
  assert.equal(md('```\n<!here>\n```'), '# Title\n\n```\n&lt;!here&gt;\n```');
  assert.equal(slackMarkdown(parse('Body', 'x', '<!channel>')), '# &lt;!channel&gt;\n\nBody');
  assert.equal(slackReply(['Added: <!channel> @here']), '*Updated*\n• Added: &lt;!channel&gt; @⁠here');
  assert.equal(slackReply(['Changed: A', '  Added: <!here>']), '*Updated*\n• Changed: A\n    ◦ Added: &lt;!here&gt;');
});

test('REQ16: a character meant literally stays literal', () => {
  assert.equal(md('snake_case and 2 \\* 3'), '# Title\n\nsnake\\_case and 2 \\* 3');
  assert.equal(md('\\# not a heading'), '# Title\n\n\\# not a heading');
  assert.equal(md('```\n```inner\n```'.replace('```inner', '~~~')), '# Title\n\n```\n~~~\n```');
});

test('REQ16: a comment and a region marker are dropped, and the region is rendered', () => {
  assert.equal(md('<!-- backlog:tasks -->\n- [ ] in the region\n<!-- /backlog:tasks -->\n'), '# Title\n\n- [ ] in the region');
});

test('REQ16: only http, https, and mailto stay links; an image is its alt text', () => {
  assert.equal(md('[a](https://x.example/a_(b))'), '# Title\n\n[a](https://x.example/a_(b%29)');
  assert.equal(md('[spec](../other/spec.md)'), '# Title\n\nspec');
  assert.equal(md('[x](javascript:alert(1))'), '# Title\n\nx');
  assert.equal(md('![a diagram](./d.png)'), '# Title\n\na diagram');
});

test('REQ2: a channel from its link or its id', () => {
  assert.equal(readChannel('C0123ABCDE'), 'C0123ABCDE');
  assert.equal(readChannel('https://acme.slack.com/archives/C0123ABCDE'), 'C0123ABCDE');
  assert.equal(readChannel('https://acme.slack.com/archives/G0123ABCDE/p1700000000000000'), 'G0123ABCDE');
  assert.equal(readChannel('https://app.slack.com/client/T0123ABC/C0123ABCDE'), 'C0123ABCDE');
  for (const bad of ['nope', 'https://example.com/archives/C0123ABCDE', 'https://acme.slack.com/team/U0123ABCDE']) assert.throws(() => readChannel(bad), ProviderError);
});

test('REQ14: the address makes the app with the manifest filled in and no more than it needs', () => {
  const url = new URL(createAppAddress());
  assert.equal(url.searchParams.get('new_app'), '1');
  const manifest = JSON.parse(url.searchParams.get('manifest_json') ?? '{}') as { oauth_config: { scopes: { bot: string[] } } };
  assert.deepEqual(manifest.oauth_config.scopes.bot, ['chat:write', 'chat:write.public']);
});
