import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { t, messageExists, formatAgorot, LOCALE, DIRECTION } from '@/shared/i18n';
import { resetPasswordTemplate, verifyEmailTemplate } from '@/server/mail';

/**
 * The language gate, made mechanical.
 *
 * CLAUDE.md: the PRODUCT is Arabic only — every string a human sees, including transactional
 * email, validation messages and empty states. English or Hebrew user-facing copy is a bug,
 * not a nit. This file checks the message catalogue itself, so a hardcoded English string in
 * a JSON file cannot survive a merge.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const messagesDir = path.join(repoRoot, 'messages', 'ar');

const ARABIC = /[؀-ۿݐ-ݿ]/;
const LATIN_WORD = /\b[A-Za-z]{3,}\b/;
const HEBREW = /[֐-׿]/;

/**
 * Words that legitimately stay in Latin script inside Arabic copy: brand names, protocols and
 * technical terms an Arabic speaker reads as-is. Anything NOT on this list must be Arabic.
 */
const ALLOWED_LATIN = new Set([
  'SEO',
  'PWA',
  'WhatsApp',
  'Waze',
  'admin',
  'app',
  'RRGGBB',
  'JPEG',
  'PNG',
  'WebP',
  'diwan',
  'neon',
  'souq',
  'warsheh',
]);

function collectStrings(node: unknown, trail: string[] = []): Array<[string, string]> {
  if (typeof node === 'string') return [[trail.join('.'), node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => collectStrings(v, [...trail, String(i)]));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => collectStrings(v, [...trail, k]));
  }
  return [];
}

function messageFiles(): string[] {
  return readdirSync(messagesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(messagesDir, f));
}

describe('the message catalogue', () => {
  it('ships exactly one locale, ar, with dir=rtl', () => {
    expect(LOCALE).toBe('ar');
    expect(DIRECTION).toBe('rtl');
  });

  it('has a namespace file per surface', () => {
    const files = messageFiles().map((f) => path.basename(f, '.json')).sort();
    expect(files).toEqual(
      ['admin', 'billing', 'common', 'dashboard', 'demo', 'media', 'storefront'].sort(),
    );
  });

  it('contains no Hebrew anywhere', () => {
    for (const file of messageFiles()) {
      const content = readFileSync(file, 'utf8');
      expect(HEBREW.test(content), `${path.basename(file)} contains Hebrew`).toBe(false);
    }
  });

  it('contains no English sentences — every human-facing value is Arabic', () => {
    const offenders: string[] = [];

    for (const file of messageFiles()) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, value] of collectStrings(parsed)) {
        if (ARABIC.test(value)) continue;
        // A value with no Arabic at all is only acceptable if every Latin word in it is a
        // known technical term or brand.
        const words = value.replace(/\{\w+\}/g, '').match(/[A-Za-z]{3,}/g) ?? [];
        if (words.length === 0) continue;
        if (words.every((w) => ALLOWED_LATIN.has(w))) continue;
        offenders.push(`${path.basename(file)}:${key} = ${value}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never leaves an English word stranded inside otherwise Arabic copy', () => {
    const offenders: string[] = [];

    for (const file of messageFiles()) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, value] of collectStrings(parsed)) {
        if (!ARABIC.test(value)) continue;
        // `{name}` placeholders are English identifiers by design — code is English, copy is
        // Arabic. They are removed before the scan so the gate measures COPY, not parameters.
        const copy = value.replace(/\{\w+\}/g, '');
        const stray = (copy.match(/\b[A-Za-z]{3,}\b/g) ?? []).filter((w) => !ALLOWED_LATIN.has(w));
        if (stray.length > 0) offenders.push(`${path.basename(file)}:${key} -> ${stray.join(', ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('the translator', () => {
  it('resolves a nested key', () => {
    expect(t('common', 'app.name')).toBe('سوق برطعة');
  });

  it('interpolates named parameters', () => {
    const rendered = t('dashboard', 'lockedField.remaining', { count: 1 });
    expect(rendered).toContain('1');
    expect(rendered).toMatch(ARABIC);
  });

  it('throws on a missing key outside production, rather than shipping the key to a merchant', () => {
    expect(() => t('common', 'does.not.exist')).toThrow(/Missing message/);
    expect(messageExists('common', 'does.not.exist')).toBe(false);
  });

  it('formats money with Western digits and the shekel sign', () => {
    expect(formatAgorot(27_900)).toBe('279 ₪');
  });
});

describe('email templates', () => {
  it('are RTL and Arabic, with dir set on the html element', () => {
    const mail = resetPasswordTemplate({ name: 'أحمد', url: 'https://app.example/reset?token=x' });

    expect(mail.html).toContain('lang="ar"');
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.subject).toMatch(ARABIC);
    expect(mail.html).toMatch(ARABIC);
  });

  it('set dir on each text cell, because Outlook resets direction per table cell', () => {
    const mail = verifyEmailTemplate({ name: 'سارة', url: 'https://app.example/verify?token=x' });
    const cellDirs = mail.html.match(/<td dir="rtl"/g) ?? [];
    expect(cellDirs.length).toBeGreaterThan(2);
  });

  it('always carry a plain-text alternative containing the link', () => {
    const url = 'https://app.example/verify?token=abc';
    const mail = verifyEmailTemplate({ name: 'سارة', url });
    expect(mail.text).toContain(url);
    expect(mail.text).toMatch(ARABIC);
  });

  it('escape user-supplied names rather than interpolating them into markup', () => {
    const mail = verifyEmailTemplate({ name: '<script>x</script>', url: 'https://a.test/x' });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('state the expiry, so a dead link is never a silent surprise', () => {
    expect(verifyEmailTemplate({ name: 'س', url: 'https://a.test' }).html).toContain('24');
    expect(resetPasswordTemplate({ name: 'س', url: 'https://a.test' }).html).toContain('1');
  });
});

describe('user-facing source strings', () => {
  /**
   * A rendered component must not contain a hardcoded sentence — Arabic OR English. Arabic is
   * as much a failure as English here, because a hardcoded literal is unreachable by the i18n
   * layer and makes a second locale expensive later (CLAUDE.md keeps `ar` shippable alone but
   * the layer cheap to extend).
   */
  function tsxFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
      else if (entry.endsWith('.tsx')) out.push(full);
    }
    return out;
  }

  /**
   * Both checks below are source-text heuristics, not a JSX parser — so a comment that merely
   * TALKS about markup ("does not wrap children in `<main>` … renders one `<main id=main>`")
   * puts a `>` and a `<` around ordinary English prose and reads as a text node.
   *
   * Stripping comments first is what keeps the gate honest. The alternative — every author
   * avoiding angle brackets in prose — trains people to work around the gate, and a gate people
   * work around eventually gets weakened instead of obeyed. Only block comments and whole-line
   * `//` comments are removed, so a `//` inside a URL cannot swallow the rest of a real line.
   */
  function withoutComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
  }

  it('has no hardcoded Arabic sentence inside a JSX component', () => {
    const offenders: string[] = [];

    for (const file of tsxFiles(path.join(repoRoot, 'src', 'app'))) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      // JSX text nodes: >…< with Arabic inside, excluding interpolations.
      for (const match of source.matchAll(/>([^<>{}]*[؀-ۿ][^<>{}]*)</g)) {
        const text = match[1]!.trim();
        if (text.length > 1) offenders.push(`${path.relative(repoRoot, file)}: ${text}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('has no stray English sentence in a JSX text node either', () => {
    const offenders: string[] = [];

    for (const file of tsxFiles(path.join(repoRoot, 'src', 'app'))) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(/>([^<>{}]{8,})</g)) {
        const text = match[1]!.trim();
        if (LATIN_WORD.test(text) && text.split(/\s+/).length > 2) {
          offenders.push(`${path.relative(repoRoot, file)}: ${text}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('still catches a hardcoded sentence once comments are stripped', () => {
    // The stripper must not become an escape hatch: a real literal in real markup is still a
    // failure, and this is the test that proves the previous two can fail at all.
    const arabic = '<p>هذا نص مكتوب مباشرة في المكوّن</p>';
    const english = '<p>this sentence was hardcoded</p>';

    expect([...withoutComments(arabic).matchAll(/>([^<>{}]*[؀-ۿ][^<>{}]*)</g)]).toHaveLength(1);
    expect([...withoutComments(english).matchAll(/>([^<>{}]{8,})</g)]).toHaveLength(1);
  });
});
