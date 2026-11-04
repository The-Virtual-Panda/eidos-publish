// One parse of a file's markdown, which each plugin renders in its provider's form
// (Publish REQ7, REQ16), and the plain text a later publish measures a change
// against (REQ6). A renderer's duty: nothing a file holds becomes markup of its
// own, so hand-written HTML is shown as text and can neither inject anything nor
// forge a mention; a comment and a region's markers are dropped, and the region's
// content is rendered.
import { createHash } from 'node:crypto';
import { marked, type Token, type Tokens } from 'marked';

export interface Parsed {
  title: string;
  tokens: Token[];
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
export const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

export const inlineText = (tokens: Token[] | undefined): string =>
  (tokens ?? [])
    .map((token) => {
      if (token.type === 'image') return (token as Tokens.Image).text;
      if (token.type === 'html') return token.raw.replace(COMMENT, '');
      if (token.type === 'br') return ' ';
      const nested = (token as { tokens?: Token[] }).tokens;
      return nested ? inlineText(nested) : decodeEntities((token as { text?: string }).text ?? '');
    })
    .join('');

export function decodeEntities(text: string): string {
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

// Only a link a reader can follow stays a link: a blueprint's, a relative path's, or a script's is its text.
export function safeHref(href: string): string | null {
  const given = href.trim();
  if (/[\u0000-\u001f]/.test(given)) return null;
  return /^(https?:\/\/|mailto:)/i.test(given) ? given : null;
}

export const isTask = (item: Tokens.ListItem): boolean => item.task === true;
// a task's box is its own mark, drawn once, whichever way the parser hands it over
export const withoutBox = (tokens: Token[]): Token[] => tokens.filter((token) => (token.type as string) !== 'checkbox');

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
