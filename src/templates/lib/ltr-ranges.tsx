import { Fragment, type ReactNode } from 'react';

/**
 * Isolate NUMERIC RANGES inside Arabic copy so they read left-to-right.
 *
 * THE BUG, and it took four critic rounds and two reversals to pin down. «10:00 – 22:00» inside an
 * RTL paragraph renders as «22:00 – 10:00»: the separator is U+2013 EN DASH, bidi class ON, so
 * UAX#9 rule W4 never fuses the two number runs, the neutrals fall to N1, and the runs lay out in
 * paragraph order — first value rightmost.
 *
 * That is what the algorithm says, and it is NOT what a reader wants. A numeric range in Arabic is
 * conventionally an LTR unit, read left-to-right like a phone number rather than folded into the
 * paragraph's direction. `references/craft.md` §14 states it outright: "Time ranges … `7:00 – 22:00`
 * inside RTL text renders as `22:00 – 7:00`. Wrap every range in `<span dir="ltr">`." Rendered
 * without that, a shop open 10:00–22:00 advertises «22:00–10:00» — it appears to open at ten at
 * night, on every storefront, in the contact block, the footer and ورشة's hero facts panel.
 *
 * WHY A RENDER-SITE HELPER AND NOT A BIDI CONTROL IN THE MESSAGE STRING. That was tried, and it
 * fixes nothing where it matters: the hours a visitor actually sees are `Site.hours`, a FREE-TEXT
 * column the merchant types, which never passes through `content.hours.range` at all. A helper
 * catches both — the composed string and whatever the shopkeeper wrote.
 *
 * WHY `<bdi>` AND NOT `dir="ltr"` ON THE CONTAINER. craft.md again: "Isolate the number, not its
 * container." The value is mixed content — «السبت–الخميس 10:00–22:00 · الجمعة 14:00–22:00» — so
 * turning the whole row LTR would move the Arabic to the wrong edge. `bdi` isolates by default and
 * the attribute makes the direction explicit rather than first-strong-guessed.
 */

/**
 * A clock range: `10:00 – 22:00`, `9:30-17:00`. Deliberately narrow.
 *
 * It matches TIME ranges only, not every pair of numbers with a dash between them, because this runs
 * over text a merchant wrote and a false positive would isolate something that reads correctly
 * today. Hours are the case that is both common and wrong; a price range or a size range can earn
 * its own pattern when one actually appears.
 */
const TIME_RANGE = /\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}/g;

/**
 * Returns the text with every clock range wrapped in an LTR isolate.
 *
 * A plain string when there is nothing to isolate, so the common case adds no elements to the tree.
 */
export function isolateRanges(text: string): ReactNode {
  const matches = [...text.matchAll(TIME_RANGE)];
  if (matches.length === 0) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;

  matches.forEach((match, index) => {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <bdi dir="ltr" key={`r${index}`}>
        {match[0]}
      </bdi>,
    );
    cursor = start + match[0].length;
  });

  if (cursor < text.length) parts.push(text.slice(cursor));

  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>{part}</Fragment>
      ))}
    </>
  );
}
