// How much a message changed, and how to say so in a reply (Publish REQ6): the
// characters added and removed between the text last sent and the text now, and
// the sections added, removed, and changed by heading. Never a diff.

export interface Change {
  added_chars: number;
  removed_chars: number;
  sections_added: string[];
  sections_removed: string[];
  sections_changed: string[];
}

const HEADING = /^#{1,6} (.*)$/;

// A heading's sections, in order, each with the lines under it; what sits above
// the first heading past the title belongs to the title's section.
function sections(text: string): Array<{ heading: string; body: string }> {
  const out: Array<{ heading: string; lines: string[] }> = [];
  for (const line of text.split('\n')) {
    const match = HEADING.exec(line);
    if (match) out.push({ heading: match[1] ?? '', lines: [] });
    else if (out.length === 0) out.push({ heading: '', lines: [line] });
    else out.at(-1)!.lines.push(line);
  }
  return out.map((section) => ({ heading: section.heading, body: section.lines.join('\n') }));
}

function commonEdges(before: string, after: string): number {
  let start = 0;
  const shorter = Math.min(before.length, after.length);
  while (start < shorter && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < shorter - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return start + end;
}

// A line's longest common subsequence finds what stayed; each run of lines
// between what stayed is measured with its common start and end taken off, so
// a word fixed in a long paragraph counts as that word.
export function measure(before: string, after: string): { added: number; removed: number } {
  const a = before.split('\n');
  const b = after.split('\n');
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  let added = 0;
  let removed = 0;
  let oldRun: string[] = [];
  let newRun: string[] = [];
  const close = (): void => {
    const was = oldRun.join('\n');
    const now = newRun.join('\n');
    const same = commonEdges(was, now);
    added += now.length - same;
    removed += was.length - same;
    oldRun = [];
    newRun = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || table[i]![j + 1]! >= table[i + 1]![j]!)) newRun.push(b[j++]!);
    else oldRun.push(a[i++]!);
  }
  close();
  return { added, removed };
}

export function changeBetween(before: string, after: string): Change {
  const { added, removed } = measure(before, after);
  const was = sections(before);
  const now = sections(after);
  const named = (list: typeof was, heading: string): (typeof was)[number] | undefined => list.find((section) => section.heading === heading);
  return {
    added_chars: added,
    removed_chars: removed,
    sections_added: now.filter((section) => !named(was, section.heading)).map((section) => section.heading),
    sections_removed: was.filter((section) => !named(now, section.heading)).map((section) => section.heading),
    sections_changed: now
      .filter((section) => {
        const held = named(was, section.heading);
        return held !== undefined && held.body !== section.body;
      })
      .map((section) => section.heading),
  };
}

export const worthReplying = (change: Change, minChars: number): boolean =>
  change.added_chars + change.removed_chars >= minChars || change.sections_added.length > 0 || change.sections_removed.length > 0;

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function replyLines(change: Change): string[] {
  const line = (label: string, headings: string[]): string[] => (headings.length === 0 ? [] : [`${label}: ${headings.join(', ')}`]);
  const lines = [...line('Added', change.sections_added), ...line('Removed', change.sections_removed), ...line('Changed', change.sections_changed)];
  return lines.length > 0 ? lines : ['The text changed.'];
}

export const replyHtml = (change: Change): string =>
  `<p><strong>Updated</strong></p><ul>${replyLines(change)
    .map((line) => `<li>${escape(line)}</li>`)
    .join('')}</ul>`;
