// One parse of a file's markdown and what is made of it (Publish REQ7, REQ16):
// the HTML a Teams message carries, and the plain text a later publish measures
// a change against (REQ6). Nothing a file holds becomes markup of its own: its
// hand-written HTML is shown as text, so it can neither inject anything nor
// forge a mention; a comment and a region's markers are dropped, and the
// region's content is rendered.
import { createHash } from 'node:crypto';
import { marked, type Token, type Tokens } from 'marked';

export interface Parsed {
  title: string;
  tokens: Token[];
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

const inlineText = (tokens: Token[] | undefined): string =>
  (tokens ?? [])
    .map((token) => {
      if (token.type === 'image') return (token as Tokens.Image).text;
      if (token.type === 'html') return token.raw.replace(COMMENT, '');
      if (token.type === 'br') return ' ';
      const nested = (token as { tokens?: Token[] }).tokens;
      return nested ? inlineText(nested) : decodeEntities((token as { text?: string }).text ?? '');
    })
    .join('');

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name] ?? '');
}

// The file as a message: its frontmatter gone, its title given or the first
// heading's, and that heading gone from the body when it only repeats the title.
export function parse(markdown: string, fallbackTitle: string, givenTitle?: string): Parsed {
  const tokens = marked.lexer(markdown.replace(FRONTMATTER, ''), { gfm: true });
  const first = tokens.find((token) => token.type !== 'space' && !(token.type === 'html' && token.raw.replace(COMMENT, '').trim() === ''));
  const opening = first?.type === 'heading' && (first as Tokens.Heading).depth === 1 ? inlineText((first as Tokens.Heading).tokens).trim() : null;
  const title = givenTitle?.trim() || opening || fallbackTitle;
  return { title, tokens: opening === title ? tokens.filter((token) => token !== first) : tokens };
}

// ---- Teams: the HTML of a channel message ---------------------------------------------

// An entity already written stays one; it reads as its character and is never markup.
const escape = (text: string): string =>
  text
    .replace(/&(?!#?\w+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const escapeCode = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Only a link a reader can follow stays a link: a blueprint's, a relative path's, or a script's is its text.
function safeHref(href: string): string | null {
  const given = href.trim();
  if (/[\u0000-\u001f]/.test(given)) return null;
  return /^(https?:\/\/|mailto:)/i.test(given) ? given : null;
}

function inlineHtml(tokens: Token[] | undefined): string {
  return (tokens ?? [])
    .map((token) => {
      switch (token.type) {
        case 'strong':
          return `<strong>${inlineHtml((token as Tokens.Strong).tokens)}</strong>`;
        case 'em':
          return `<em>${inlineHtml((token as Tokens.Em).tokens)}</em>`;
        case 'del':
          return `<s>${inlineHtml((token as Tokens.Del).tokens)}</s>`;
        case 'codespan':
          return `<code>${escapeCode(decodeEntities((token as Tokens.Codespan).text))}</code>`;
        case 'br':
          return '<br>';
        case 'image':
          return escape((token as Tokens.Image).text);
        case 'html':
          return escape(token.raw.replace(COMMENT, ''));
        case 'link': {
          const link = token as Tokens.Link;
          const href = safeHref(link.href);
          const text = inlineHtml(link.tokens);
          return href ? `<a href="${escape(href)}">${text}</a>` : text;
        }
        default: {
          const nested = (token as { tokens?: Token[] }).tokens;
          if (nested) return inlineHtml(nested);
          return escape((token as { text?: string }).text ?? token.raw).replace(/\r?\n/g, ' ');
        }
      }
    })
    .join('');
}

const isTask = (item: Tokens.ListItem): boolean => item.task === true;
// a task's box is its own mark, drawn once, whichever way the parser hands it over
const withoutBox = (tokens: Token[]): Token[] => tokens.filter((token) => (token.type as string) !== 'checkbox');

function blocksHtml(tokens: Token[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'heading': {
          const heading = token as Tokens.Heading;
          return `<h${heading.depth}>${inlineHtml(heading.tokens)}</h${heading.depth}>`;
        }
        case 'paragraph':
          return `<p>${inlineHtml((token as Tokens.Paragraph).tokens)}</p>`;
        case 'text': {
          const text = token as Tokens.Text;
          return text.tokens ? inlineHtml(text.tokens) : escape(text.text);
        }
        case 'code':
          return `<pre><code>${escapeCode((token as Tokens.Code).text)}</code></pre>`;
        case 'blockquote':
          return `<blockquote>${blocksHtml((token as Tokens.Blockquote).tokens)}</blockquote>`;
        case 'hr':
          return '<hr>';
        case 'html': {
          const text = token.raw.replace(COMMENT, '').trim();
          return text === '' ? '' : `<p>${escape(text)}</p>`;
        }
        case 'list': {
          const list = token as Tokens.List;
          const tag = list.ordered ? 'ol' : 'ul';
          const start = list.ordered && typeof list.start === 'number' && list.start !== 1 ? ` start="${list.start}"` : '';
          const items = list.items.map((item) => `<li>${isTask(item) ? (item.checked ? '☑ ' : '☐ ') : ''}${blocksHtml(withoutBox(item.tokens))}</li>`);
          return `<${tag}${start}>${items.join('')}</${tag}>`;
        }
        case 'table': {
          const table = token as Tokens.Table;
          const cells = (row: Tokens.TableCell[], tag: 'th' | 'td'): string => `<tr>${row.map((cell) => `<${tag}>${inlineHtml(cell.tokens)}</${tag}>`).join('')}</tr>`;
          return `<table><thead>${cells(table.header, 'th')}</thead><tbody>${table.rows.map((row) => cells(row, 'td')).join('')}</tbody></table>`;
        }
        default:
          return '';
      }
    })
    .join('');
}

export function teamsHtml(parsed: Parsed): string {
  return `<h1>${escape(parsed.title)}</h1>${blocksHtml(parsed.tokens)}`;
}

// ---- plain text: what a change is measured against ------------------------------------

function blocksPlain(tokens: Token[], indent = ''): string[] {
  return tokens.flatMap((token) => {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        return [`${'#'.repeat(heading.depth)} ${inlineText(heading.tokens).trim()}`];
      }
      case 'paragraph':
      case 'text': {
        const text = inlineText((token as Tokens.Paragraph).tokens ?? [token]);
        // a line of a paragraph that opens with `#` is not a heading to whoever reads the text back
        return text.split('\n').map((line) => `${indent}${line.replace(/^#/, '\\#')}`);
      }
      case 'code':
        return (token as Tokens.Code).text.split('\n').map((line) => `${indent}    ${line}`);
      case 'blockquote':
        return blocksPlain((token as Tokens.Blockquote).tokens, `${indent}> `);
      case 'hr':
        return [`${indent}---`];
      case 'html': {
        const text = token.raw.replace(COMMENT, '').trim();
        return text === '' ? [] : text.split('\n').map((line) => `${indent}${line}`);
      }
      case 'list':
        return (token as Tokens.List).items.flatMap((item) => {
          const [head = '', ...rest] = blocksPlain(withoutBox(item.tokens), `${indent}  `);
          const box = isTask(item) ? (item.checked ? '[x] ' : '[ ] ') : '';
          return [`${indent}- ${box}${head.slice(indent.length + 2)}`, ...rest];
        });
      case 'table': {
        const table = token as Tokens.Table;
        const row = (cells: Tokens.TableCell[]): string => `${indent}| ${cells.map((cell) => inlineText(cell.tokens).trim()).join(' | ')} |`;
        return [row(table.header), ...table.rows.map(row)];
      }
      default:
        return [];
    }
  });
}

export const plainText = (parsed: Parsed): string => [`# ${parsed.title}`, ...blocksPlain(parsed.tokens)].join('\n');

export const digest = (message: string): string => `sha256:${createHash('sha256').update(message).digest('hex')}`;
