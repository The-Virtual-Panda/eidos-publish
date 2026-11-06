// How much a message changed, and how to say so in a reply (Publish REQ6, REQ26): the
// characters added and removed between the text last sent and the text now, the
// sections added, removed, and changed by heading, and under each changed section the
// list items added, removed, and edited. Never a diff.

export interface SectionItems {
  section: string;
  added: string[];
  removed: string[];
  // an item edited in place, as it now reads
  edited: string[];
}

export interface Change {
  added_chars: number;
  removed_chars: number;
  sections_added: string[];
  sections_removed: string[];
  sections_changed: string[];
  items: SectionItems[];
  // a shared property's line, as `Date: before → after`
  properties_changed: string[];
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

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/;
const itemsOf = (text: string): string[] => text.split('\n').flatMap((line) => ITEM.exec(line)?.slice(1, 2) ?? []);
// The lines above the first heading past the title that a person chose to share read `Label: value`; a list item never does.
const PROPERTY = /^(?!- |\s)([^:]{1,60}): (.+)$/;
const propertyLines = (text: string): Map<string, string> =>
  new Map(
    (sections(text)[0]?.body ?? '').split('\n').flatMap((line): Array<[string, string]> => {
      const match = PROPERTY.exec(line);
      return match ? [[match[1]!, match[2]!]] : [];
    }),
  );

// How much of the shorter of two items an edit left at their start and end that still makes them one item.
const SAME_ITEM = 0.6;

// An item edited in place would otherwise read as one removed and one added; each
// added item takes the removed item most like it. Items are compared by their edges,
// which also keep a fix in the middle of a long item, and two different items that
// open alike fall short of SAME_ITEM.
function itemsIn(section: string, added: string[], removed: string[]): SectionItems {
  const left = [...removed];
  const edited: string[] = [];
  const unmatched = added.filter((item) => {
    const likeness = left.map((other) => commonEdges(other, item) / Math.min(other.length, item.length));
    const best = Math.max(0, ...likeness);
    if (best < SAME_ITEM) return true;
    left.splice(likeness.indexOf(best), 1);
    edited.push(item);
    return false;
  });
  return { section, added: unmatched, removed: left, edited };
}

export function changeBetween(before: string, after: string): Change {
  const { added, removed } = measure(before, after);
  const was = sections(before);
  const now = sections(after);
  const itemsBefore = itemsOf(before);
  const itemsAfter = itemsOf(after);
  const named = (list: typeof was, heading: string): (typeof was)[number] | undefined => list.find((section) => section.heading === heading);
  const withoutProperties = (body: string): string => body.split('\n').filter((line) => !PROPERTY.test(line)).join('\n');
  return {
    // A new or removed section is named whole, and an item moved between sections was neither added nor removed.
    items: now.flatMap((section) => {
      const held = named(was, section.heading);
      if (held === undefined) return [];
      const items = itemsIn(section.heading, itemsOf(section.body).filter((item) => !itemsBefore.includes(item)), itemsOf(held.body).filter((item) => !itemsAfter.includes(item)));
      return items.added.length + items.removed.length + items.edited.length > 0 ? [items] : [];
    }),
    properties_changed: [...propertyLines(after)].flatMap(([label, value]) => {
      const was = propertyLines(before).get(label);
      return was !== undefined && was !== value ? [`${label}: ${was} → ${value}`] : [];
    }),
    added_chars: added,
    removed_chars: removed,
    sections_added: now.filter((section) => !named(was, section.heading)).map((section) => section.heading),
    sections_removed: was.filter((section) => !named(now, section.heading)).map((section) => section.heading),
    sections_changed: now
      .filter((section) => {
        const held = named(was, section.heading);
        if (held === undefined) return false;
        // a shared property's change is said as itself, not as a change to the title's section
        return section === now[0] ? withoutProperties(held.body) !== withoutProperties(section.body) : held.body !== section.body;
      })
      .map((section) => section.heading),
  };
}

export const worthReplying = (change: Change, minChars: number): boolean =>
  change.added_chars + change.removed_chars >= minChars || change.items.some((items) => items.added.length > 0 || items.removed.length > 0) || change.properties_changed.length > 0 || change.sections_added.length > 0 || change.sections_removed.length > 0;

// A reply's item is a line, not the whole of a long one.
const ITEM_LIMIT = 140;
function shortened(item: string): string {
  if (item.length <= ITEM_LIMIT) return item;
  const cut = item.slice(0, ITEM_LIMIT);
  const word = cut.lastIndexOf(' ');
  return `${(word > 0 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

// A reply's lines, the items under their section indented by NESTED, which every
// service draws as its own nested list and `replyTree` reads back.
const NESTED = '  ';

export function replyLines(change: Change): string[] {
  const line = (label: string, headings: string[]): string[] => (headings.length === 0 ? [] : [`${label}: ${headings.join(', ')}`]);
  const under = (section: string): string[] => {
    const items = change.items.find((held) => held.section === section);
    if (items === undefined) return [];
    const each = (label: string, list: string[]): string[] => list.map((item) => `${NESTED}${label}: ${shortened(item)}`);
    return [...each('Added', items.added), ...each('Removed', items.removed), ...each('Edited', items.edited)];
  };
  const lines = [
    ...change.properties_changed,
    ...line('Added', change.sections_added), ...line('Removed', change.sections_removed),
    ...change.sections_changed.flatMap((section) => [`Changed: ${section}`, ...under(section)]),
  ];
  return lines.length > 0 ? lines : ['The text changed.'];
}

// What every service's reply opens with, and the page's preview of one.
export const REPLY_TITLE = 'Updated';

export const isNested = (line: string): boolean => line.startsWith(NESTED);

export function replyTree(lines: string[]): Array<{ text: string; items: string[] }> {
  const tree: Array<{ text: string; items: string[] }> = [];
  for (const line of lines) {
    if (isNested(line) && tree.length > 0) tree.at(-1)!.items.push(line.slice(NESTED.length));
    else tree.push({ text: line, items: [] });
  }
  return tree;
}
