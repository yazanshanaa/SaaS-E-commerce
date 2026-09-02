import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
  /**
   * Phase 4's DNS vocabulary. These four are not untranslated English — they are the LITERAL
   * strings a merchant has to find in their registrar's own control panel, which is in English
   * whatever language we write in. Translating «سجل اسم مستعار» for CNAME would leave a shop
   * owner hunting a menu item that does not exist under that name, which is the opposite of
   * helping. CLAUDE.md allows exactly this: technical words Arabic speakers use as-is.
   *
   * `Cloudflare` is a company name, and the warning it appears in is the single most common
   * failure of the whole domain flow (docs/DOMAINS.md §1).
   *
   * What is NOT here, deliberately: example hostnames. `shop.example.com` is a placeholder, not
   * vocabulary, so it travels as an i18n PARAMETER from the page rather than living in the copy —
   * the gate strips `{name}` before scanning, and a future locale gets to change the example.
   */
  'CNAME',
  'TXT',
  'DNS',
  'Cloudflare',
  /**
   * Phase 6's processors list. These are COMPANY NAMES in a legal disclosure, and a legal
   * disclosure that translates the name of the company holding your data has told you nothing —
   * a data subject who wants to look one up needs the string the company answers to. Standard
   * practice in Arabic privacy policies, and the same allowance CLAUDE.md already makes for
   * technical vocabulary Arabic speakers use as-is.
   *
   * `n8n` and `R2` are absent because they contain digits and never match a run of three letters.
   * Payment-gateway names are absent for a better reason: the generator passes the provider as an
   * i18n PARAMETER, so a future locale gets the sentence and the platform supplies the name.
   */
  'Resend',
  'Umami',
  'Sentry',
  /** The transport, named in the security clause because a reader looking for it expects it. */
  'HTTPS',
  /**
   * The URL SCHEMES, lowercase, as a person types them into a field.
   *
   * `HTTPS` above is the protocol named in a legal clause; these two are the literal prefix the
   * platform validates a link against and tells the operator to start with. Same allowance, and
   * lowercase because the Set is case-sensitive and the copy is about what goes in the box.
   */
  'https',
  'http',
]);

/**
 * Keys whose VALUE contains a literal command, path or filename — exempt from the stranded-word
 * scan, by key rather than by word.
 *
 * The alternative was to add `list`, `show`, `into`, `capture`, `stamp`, `purge`, `replay`,
 * `restore` and `docs` to `ALLOWED_LATIN`, and that would have been the wrong trade: those are
 * ordinary English words, and allowing them GLOBALLY means the next person who writes «اضغط show»
 * in an unrelated string sails through the gate this file exists to be. Exempting six named keys
 * costs nothing anywhere else.
 *
 * What is exempt is the operator runbook in `admin.json`: shell commands (`restore.sh show
 * <stamp>`, `pnpm purge:replay`) and a documentation path (`docs/DEPLOY.md`). Translating them
 * would leave a super admin — mid-incident, restoring a database — typing a command that does not
 * exist. That is the same reasoning CLAUDE.md already makes for CNAME and DNS above, applied to
 * strings rather than to vocabulary.
 *
 * These are the ONLY six. `backups.restore.steps.verify` and `.record` carry no command and are
 * scanned like everything else, which is the point: the exemption is per string, not per screen.
 */
const LITERAL_COMMAND_KEYS = new Set([
  'admin.json:backups.lifecycle.fix',
  'admin.json:backups.restore.steps.capture',
  'admin.json:backups.restore.steps.list',
  'admin.json:backups.restore.steps.show',
  'admin.json:backups.restore.steps.into',
  'admin.json:backups.restore.steps.replay',
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
      [
        // `legal` joined in Phase 6 — the generated policy copy, kept apart from the storefront's
        // labels because it is paragraphs rather than UI strings. See src/shared/i18n/index.ts.
        //
        // Note that `legal` is deliberately OUTSIDE the `NAMESPACES` allow-lists in
        // `src/app/{dashboard,admin}/_components/messages.ts`: it is rendered as page copy by
        // `src/server/legal`, never returned as a message key by a server action, so letting a
        // banner resolve a paragraph of a privacy policy would be a widening with no caller.
        'admin',
        'billing',
        'common',
        'dashboard',
        'demo',
        'legal',
        'media',
        'storefront',
        // Phase 9's five per-domain catalogues. Five FILES rather than five blocks inside
        // dashboard.json (src/shared/i18n/index.ts explains why): five parallel tracks appending to
        // one forty-kilobyte file is five merge conflicts, and each of these is a domain with both a
        // dashboard half and a storefront half.
        'catalogue',
        'content',
        'insights',
        'delivery',
        'customers',
        // Phase 11 (Track 11.D). The appearance studio and the live `/preview` share one
        // catalogue: the picker copy, the contrast verdicts and the preview's Arabic sample
        // fixture are the same vocabulary, and none of it belongs in dashboard.json.
        'appearance',
      ].sort(),
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
        // A shell command or a file path the operator must type verbatim — see the note on the set.
        if (LITERAL_COMMAND_KEYS.has(`${path.basename(file)}:${key}`)) continue;
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
   * This gate PARSES the file rather than pattern-matching its text.
   *
   * It used to be a regex for `>…<` with the comments stripped first, and that heuristic cannot
   * tell a JSX text node from ordinary code sitting between two JSX blocks: `searchParams:
   * Promise<Record<string, string>>` followed by a `return (` and a tag reads as a text node
   * containing the word "return", and so does every `case 'x': return (` between two rendered
   * fragments. It reported seventeen such "sentences" in A1, none of them strings — and the
   * dangerous part was not the noise but the fix it invites, which is to loosen the pattern.
   *
   * `typescript` is already a devDependency, so an exact parse costs nothing and is strictly
   * stronger: comments are no longer text (nothing needs stripping), and a hardcoded string in
   * a JSX ATTRIBUTE — a hole the regex never saw at all — is now caught too.
   */
  interface JsxLiteral {
    text: string;
    /** The attribute it came from, or null for a text node / `{'…'}` expression. */
    attribute: string | null;
  }

  function jsxLiterals(file: string): JsxLiteral[] {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const out: JsxLiteral[] = [];
    const push = (text: string, attribute: string | null) => {
      const trimmed = text.trim();
      if (trimmed) out.push({ text: trimmed, attribute });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node)) {
        push(node.text, null);
      } else if (
        ts.isJsxAttribute(node) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      ) {
        push(node.initializer.text, node.name.getText(source));
      } else if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression)) {
        push(node.expression.text, null);
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
    return out;
  }

  /**
   * Attributes that carry COPY. `className`, `href` and friends are structural and full of
   * Latin by design; scanning them for English would flag every stylesheet hook in the panel.
   * Arabic, by contrast, is checked in EVERY attribute — it has no business in any of them.
   */
  const COPY_ATTRIBUTES = new Set([
    'placeholder',
    'title',
    'alt',
    'aria-label',
    'aria-description',
    'aria-placeholder',
    'label',
    'summary',
    'content',
  ]);

  /**
   * The roots the gate walks.
   *
   * `src/templates` was outside it until Group A merged, which meant every storefront component —
   * the shell, all ten sections, the product card, the header, the footer, the consent banner —
   * was exempt from the one check that enforces "no hardcoded sentence in a component". They were
   * clean when A2 was written, and nothing kept them that way; a gate with a hole in it is how
   * the first hardcoded string lands. Raised by A2 as a sync point, because this file is
   * forbidden to a track.
   */
  const scanRoots = [path.join(repoRoot, 'src', 'app'), path.join(repoRoot, 'src', 'templates')];

  const scannedFiles = (): string[] => scanRoots.flatMap((root) => tsxFiles(root));

  it('actually walks both roots', () => {
    // Without this, renaming a folder turns the two checks below into assertions about an empty
    // list — they would pass, loudly and permanently, while measuring nothing.
    for (const root of scanRoots) {
      expect(tsxFiles(root).length).toBeGreaterThan(0);
    }
  });

  it('has no hardcoded Arabic sentence inside a JSX component', () => {
    const offenders: string[] = [];

    for (const file of scannedFiles()) {
      for (const literal of jsxLiterals(file)) {
        if (!ARABIC.test(literal.text)) continue;
        offenders.push(`${path.relative(repoRoot, file)}: ${literal.text}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('has no stray English sentence in a JSX text node either', () => {
    const offenders: string[] = [];

    for (const file of scannedFiles()) {
      for (const literal of jsxLiterals(file)) {
        if (literal.attribute && !COPY_ATTRIBUTES.has(literal.attribute)) continue;
        if (!LATIN_WORD.test(literal.text)) continue;
        if (literal.text.split(/\s+/).length <= 2) continue;
        offenders.push(`${path.relative(repoRoot, file)}: ${literal.text}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('still catches a hardcoded sentence, and no longer trips over ordinary code', () => {
    // The parser must not become an escape hatch: this is the test that proves the two above
    // can fail at all, and that the false positive they used to produce is genuinely gone.
    const file = path.join(repoRoot, 'tests', '.language-gate-fixture.tsx');
    const fixture = [
      'export function Bad({ items }: { items: Promise<Record<string, string>> }) {',
      '  void items;',
      '  return (',
      '    <p title="this attribute was hardcoded">هذا نص مكتوب مباشرة في المكوّن</p>',
      '  );',
      '}',
    ].join('\n');

    writeFileSync(file, fixture, 'utf8');
    try {
      const literals = jsxLiterals(file);
      expect(literals.map((literal) => literal.text)).toEqual([
        'this attribute was hardcoded',
        'هذا نص مكتوب مباشرة في المكوّن',
      ]);
      // `Promise<Record<string, string>>` … `return (` is code, not a text node.
      expect(literals.some((literal) => literal.text.includes('return'))).toBe(false);
    } finally {
      rmSync(file, { force: true });
    }
  });
});
