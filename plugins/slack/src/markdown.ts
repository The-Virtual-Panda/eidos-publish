// A file as the markdown of a Slack message's `markdown_text` (Publish REQ7, REQ16):
// Slack renders headings, lists, task lists, tables, and code from it, up to 12,000
// characters, where its plain `text` allows 4,000. It is written out again from the
// one parse rather than sent as the file holds it, so nothing the file holds becomes
// a mention, a broadcast, or a link it should not be.
import type { Token, Tokens } from 'marked';
import { COMMENT, decodeEntities, isTask, safeHref, withoutBox, type Parsed } from '../../../packages/core/src/render.ts';

// Slack's own rule for its control characters, which also keeps `<@U123>` and `<!channel>` from being read as one.
const controls = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A plain `@channel` must not reach a whole channel either, so a word joiner sits inside it, unseen.
const broadcasts = (text: string): string => text.replace(/@(channel|here|everyone)\b/gi, '@⁠$1');
const escapeText = (text: string): string => broadcasts(controls(decodeEntities(text)).replace(/([\\`*_~[\]|])/g, '\\$1'));
// A line of a paragraph that opens like a heading or a list stays words.
const escapeOpening = (text: string): string => text.replace(/^(\s*)(#{1,6}\s|[-+]\s|\d+[.)]\s)/gm, '$1\\$2');

function inline(tokens: Token[] | undefined): string {
  return (tokens ?? [])
    .map((token) => {
      switch (token.type) {
        case 'strong':
          return `**${inline((token as Tokens.Strong).tokens)}**`;
        case 'em':
          return `*${inline((token as Tokens.Em).tokens)}*`;
        case 'del':
          return `~~${inline((token as Tokens.Del).tokens)}~~`;
        case 'codespan': {
          const code = controls(decodeEntities((token as Tokens.Codespan).text));
          return code.includes('`') ? `\`\` ${code} \`\`` : `\`${code}\``;
        }
        case 'br':
          return '\n';
        case 'image':
          return escapeText((token as Tokens.Image).text);
        case 'html':
          return escapeText(token.raw.replace(COMMENT, ''));
        case 'link': {
          const link = token as Tokens.Link;
          const href = safeHref(link.href);
          const text = inline(link.tokens);
          return href ? `[${text}](${controls(href).replace(/\)/g, '%29').replace(/ /g, '%20')})` : text;
        }
        default: {
          const nested = (token as { tokens?: Token[] }).tokens;
          if (nested) return inline(nested);
          return escapeText((token as { text?: string }).text ?? token.raw).replace(/\r?\n/g, ' ');
        }
      }
    })
    .join('');
}

const prefixLines = (text: string, prefix: string): string =>
  text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');

function blocks(tokens: Token[]): string[] {
  return tokens.flatMap((token) => {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        return [`${'#'.repeat(heading.depth)} ${inline(heading.tokens)}`];
      }
      case 'paragraph':
        return [escapeOpening(inline((token as Tokens.Paragraph).tokens))];
      case 'text': {
        const text = token as Tokens.Text;
        return [text.tokens ? inline(text.tokens) : escapeText(text.text)];
      }
      case 'code': {
        // three backticks in the code would close its fence, so a word joiner sits among them
        const code = controls((token as Tokens.Code).text).replace(/```/g, '`⁠`⁠`');
        return [`\`\`\`\n${code}\n\`\`\``];
      }
      case 'blockquote':
        return [prefixLines(blocks((token as Tokens.Blockquote).tokens).join('\n\n'), '> ')];
      case 'hr':
        return ['---'];
      case 'html': {
        const text = token.raw.replace(COMMENT, '').trim();
        return text === '' ? [] : [escapeText(text)];
      }
      case 'list': {
        const list = token as Tokens.List;
        const start = typeof list.start === 'number' ? list.start : 1;
        const items = list.items.map((item, at) => {
          const marker = list.ordered ? `${start + at}. ` : '- ';
          const box = isTask(item) ? (item.checked ? '[x] ' : '[ ] ') : '';
          const [head = '', ...rest] = blocks(withoutBox(item.tokens));
          const below = rest.map((block) => prefixLines(block, ' '.repeat(marker.length)));
          return [`${marker}${box}${head}`, ...below].join('\n');
        });
        return [items.join('\n')];
      }
      case 'table': {
        const table = token as Tokens.Table;
        const row = (cells: Tokens.TableCell[]): string => `| ${cells.map((cell) => inline(cell.tokens)).join(' | ')} |`;
        return [[row(table.header), `|${table.header.map(() => ' --- |').join('')}`, ...table.rows.map(row)].join('\n')];
      }
      default:
        return [];
    }
  });
}

export const slackMarkdown = (parsed: Parsed): string => [`# ${escapeText(parsed.title)}`, ...(parsed.properties.length === 0 ? [] : [parsed.properties.map((property) => `**${escapeText(property.label)}:** ${escapeText(property.value)}`).join('  \n')]), ...blocks(parsed.tokens)].join('\n\n');

// A reply goes as plain `text`, which a thread takes as a matter of course.
export const slackReply = (lines: string[]): string => ['*Updated*', ...lines.map((line) => `• ${broadcasts(controls(line))}`)].join('\n');
