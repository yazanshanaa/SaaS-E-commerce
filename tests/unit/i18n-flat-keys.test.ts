import { describe, expect, it } from 'vitest';
import { messageExists, t } from '@/shared/i18n';

/**
 * A message group may store its keys FLAT, with dots inside them, and it must still resolve.
 *
 * `messages/ar/admin.json` writes the audit vocabulary as `"events": { "subscription.suspended":
 * "…" }`, because those keys ARE event type identifiers — a caller thinks in `events[type]`, not
 * in a path. The resolver split on `.` and walked, so it looked for a `subscription` object inside
 * `events`, found nothing, and returned undefined.
 *
 * It failed silently, which is why it survived two tracks: both call sites guard with
 * `messageExists()` and fall back to the raw identifier, so the overview and the audit log just
 * rendered `subscription.suspended` and `plan.created` — English strings on the screens that exist
 * to tell an Arabic-speaking operator what happened, on a product whose language policy allows no
 * English user-facing copy at all. Found by B3 (docs/decisions/b3.md §12) via its own
 * `demo.created` rows.
 */
describe('flat dotted message keys', () => {
  it('resolves an event identifier stored as one flat key', () => {
    expect(messageExists('admin', 'events.subscription.suspended')).toBe(true);
    expect(t('admin', 'events.subscription.suspended')).toBe('إيقاف الاشتراك');
  });

  it('resolves the demo events B3 writes, which is how this was found', () => {
    expect(t('admin', 'events.demo.created')).not.toBe('events.demo.created');
    expect(t('admin', 'events.demo.created')).toMatch(/[\u0600-\u06FF]/);
  });

  it('resolves A1s audit actions, affected by the same walk', () => {
    expect(messageExists('admin', 'actions.plan.created')).toBe(true);
    expect(t('admin', 'actions.plan.created')).toMatch(/[\u0600-\u06FF]/);
  });

  it('still resolves an ordinary nested key', () => {
    expect(t('admin', 'nav.demos')).toBe('النسخ التجريبية');
  });

  /**
   * The fallback must not invent hits. It runs only after the ordinary walk has failed, so a key
   * that resolves to nothing under either spelling still resolves to nothing.
   */
  it('does not turn a missing key into a match', () => {
    expect(messageExists('admin', 'events.nothing.like.this')).toBe(false);
    expect(messageExists('admin', 'nav.notAScreen')).toBe(false);
  });
});


/**
 * THE HOURS RANGE IS ISOLATED AT THE RENDER SITE, AND THIS TEST ONCE ASSERTED THE OPPOSITE.
 *
 * Worth recording in full, because the mistake was made confidently and reversed twice.
 *
 * «10:00 – 22:00» inside an RTL paragraph renders as «22:00 – 10:00». The separator is U+2013 EN
 * DASH, bidi class ON, so UAX#9 rule W4 — which fuses a single ES/CS separator between two European
 * numbers into one number run — never fires; the neutrals fall to N1 and the two times lay out in
 * paragraph order, first value RIGHTMOST. Measured on the page: 10:00 at x=1027, 22:00 at x=974.
 *
 * From that I concluded the render was correct and that an isolate would reverse it, and this file
 * briefly asserted the string carried NO bidi controls. The algorithm reasoning was right and the
 * conclusion was wrong: a numeric range in Arabic is conventionally an LTR unit, read left-to-right
 * like a phone number rather than folded into the paragraph. `references/craft.md` §14 says it
 * outright — "Time ranges … `7:00 – 22:00` inside RTL text renders as `22:00 – 7:00`. Wrap every
 * range in `<span dir=\"ltr\">`." Unwrapped, a shop open 10:00–22:00 advertises «22:00–10:00».
 *
 * THE FIX IS NOT IN THIS STRING, and that is the second thing this test exists to record. The hours
 * a visitor actually reads are `Site.hours` — a FREE-TEXT column the merchant types — which never
 * passes through `content.hours.range` at all. Putting U+2066…U+2069 here was tried and fixed
 * nothing on the page. `lib/ltr-ranges.tsx` wraps every clock range in `<bdi dir="ltr">` at the four
 * render sites instead, which catches the composed string and the merchant's own text alike.
 *
 * So the assertion here is only that the string stays PLAIN — no stray controls competing with the
 * markup — and that the separator stays an en dash, since U+002D is class ES and would trigger W4.
 */
describe('the opening-hours range', () => {
  it('stays plain: the LTR isolation belongs to lib/ltr-ranges, not to the message', () => {
    const range = t('content', 'hours.range');

    expect(range).toBe('{from} – {to}');
    expect(
      /[⁦-⁩‎‏]/.test(range),
      'bidi controls here would compete with the <bdi> wrapper at the render site',
    ).toBe(false);
  });

  it('keeps the en dash rather than an ASCII hyphen', () => {
    const range = t('content', 'hours.range');

    expect(range).toContain('–');
    expect(range, 'U+002D is class ES and changes how the range resolves').not.toContain('-');
  });
});
