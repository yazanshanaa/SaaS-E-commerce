import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isolateRanges } from '@/templates/lib/ltr-ranges';

/**
 * The mechanism that actually fixes the opening hours on a storefront.
 *
 * A clock range inside RTL Arabic renders with its first value RIGHTMOST, because the en-dash
 * between two number runs is a neutral that resolves to the paragraph direction. Arabic convention
 * — and `references/craft.md` §14 — wants the range read left-to-right as a unit, so each one is
 * wrapped in `<bdi dir="ltr">`. Verified on the page: before, the opening time sat at x=1027 and the
 * closing time at x=974; after, 974 and 1027.
 *
 * These cases pin the two properties that matter: ranges ARE wrapped, and the surrounding Arabic is
 * NOT — the whole point of isolating the number rather than its container.
 */
describe('isolateRanges', () => {
  it('wraps every clock range in an LTR isolate', () => {
    const html = renderToStaticMarkup(
      <>{isolateRanges('السبت–الخميس 10:00–22:00 · الجمعة 14:00–22:00')}</>,
    );

    expect(html).toContain('<bdi dir="ltr">10:00–22:00</bdi>');
    expect(html).toContain('<bdi dir="ltr">14:00–22:00</bdi>');
  });

  it('leaves the Arabic around them alone', () => {
    const html = renderToStaticMarkup(<>{isolateRanges('السبت–الخميس 10:00–22:00')}</>);

    // The day span is two Arabic words either side of the same dash and must NOT be isolated:
    // both sides are strong RTL, so it already reads correctly and wrapping it would break it.
    expect(html).not.toContain('<bdi dir="ltr">السبت');
    expect(html).toContain('السبت–الخميس');
  });

  it('returns the string untouched when there is no range to isolate', () => {
    expect(isolateRanges('برطعة — شارع السوق الرئيسي')).toBe('برطعة — شارع السوق الرئيسي');
  });

  it('handles a hyphen-separated range and a single time', () => {
    const html = renderToStaticMarkup(<>{isolateRanges('الجمعة 9:30-17:00 والسبت 8:00')}</>);

    expect(html).toContain('<bdi dir="ltr">9:30-17:00</bdi>');
    // A lone time has no neutral between two numbers, so it needs no isolate.
    expect(html).toContain('8:00');
    expect(html).not.toContain('<bdi dir="ltr">8:00</bdi>');
  });
});
