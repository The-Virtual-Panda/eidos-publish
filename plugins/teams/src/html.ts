// A file as the HTML of a Teams channel message (Publish REQ7, REQ16, REQ17).
import type { Token, Tokens } from 'marked';
import { COMMENT, decodeEntities, isTask, safeHref, withoutBox, type Parsed } from '../../../packages/core/src/render.ts';

// An entity already written stays one; it reads as its character and is never markup.
const escape = (text: string): string =>
  text
    .replace(/&(?!#?\w+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const escapeCode = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
