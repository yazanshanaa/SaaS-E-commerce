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
