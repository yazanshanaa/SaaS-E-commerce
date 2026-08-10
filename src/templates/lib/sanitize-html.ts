/**
 * The `custom_html` sanitiser.
 *
 * An ALLOW-LIST tokeniser, not a blocklist: everything that is not explicitly permitted is
 * dropped, including its attributes. A blocklist ("strip &lt;script&gt;") loses to the first
 * `<svg onload>` or `<img src=x onerror>` anyone tries.
 *
 * Three layers guard this section, and the sanitiser is only the third:
 *   1. availability — the section renders only when the tenant's feature gate says so
 *      (see `custom-html-gate.ts`); a basic-plan merchant cannot reach it at all,
 *   2. demo tenants NEVER render it, whatever the flag says,
 *   3. this function, which removes anything that could execute.
 *
 * Known limitation, stated rather than hidden: this is a hand-written parser because a
 * dependency cannot be added from a worktree (docs/PHASES.md, sync point 2). It is conservative
 * — malformed markup is dropped, not repaired — and Phase 6's hardening pass should replace it
 * with a vetted library and keep these tests.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'hr',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'small',
  'span',
  'div',
  'section',
  'article',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'figure',
  'figcaption',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
]);

/** Void elements: they never carry a closing tag, so the stack must not wait for one. */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * Attributes are allow-listed PER TAG. A global list would let `href` onto a `<div>` and
 * `srcset` onto an `<a>`, and every "harmless" extra attribute is one more parser to be wrong
 * about. `style` is absent on purpose: it can load a URL and can cover the whole viewport.
 */
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'rel', 'target']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
};

/** Only these schemes may appear in an href. No `javascript:`, no `data:`, no `blob:`. */
const SAFE_URL = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

/**
 * A `src` is held to a stricter rule than an `href`, and the difference is the whole point.
 *
 * A link is inert until someone clicks it. An `<img src>` is a REQUEST, issued on first paint,
 * to whatever host it names — which is a tracking pixel with an `alt` attribute. On a storefront
 * whose entire compliance claim is "no third-party request before the visitor has answered the
 * banner", one line of pasted HTML would have made that claim false, silently, on a page the
 * merchant controls and nobody reviews. `analyticsDecision()` cannot help: it governs the Umami
 * tag, not arbitrary markup.
 *
 * So an image must be SAME-ORIGIN: a root-relative path. That still covers every legitimate use
 * (the media library serves through the CDN, and A3's pipeline is how an image is meant to get
 * onto a page at all) and refuses the one that is indistinguishable from surveillance.
 */
const SAFE_SRC = /^\/(?!\/)/;

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Control characters are stripped first: `java\tscript:` is a real bypass. */
function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((ch) => (ch.codePointAt(0) ?? 0) > 0x20)
    .join('');
}

function isSafeUrl(value: string): boolean {
  return SAFE_URL.test(stripControlCharacters(value));
}

/** Same-origin only — see `SAFE_SRC`. A remote `src` is a request, not a link. */
function isSafeSrc(value: string): boolean {
  return SAFE_SRC.test(stripControlCharacters(value));
}

function sanitiseAttributes(tag: string, raw: string): string {
  const allowed = ALLOWED_ATTRIBUTES[tag];
  if (!allowed) return '';

  const out: string[] = [];
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

  for (const match of raw.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';

    // Belt and braces: every `on*` handler is rejected before the allow-list is even consulted.
    if (name.startsWith('on')) continue;
    if (!allowed.has(name)) continue;
    if (name === 'href' && !isSafeUrl(value)) continue;
    // A dropped `src` leaves an `<img>` with no source, which renders its `alt` — the merchant
    // sees their caption and the visitor's browser contacts nobody.
    if (name === 'src' && !isSafeSrc(value)) continue;

    out.push(`${name}="${escapeText(value)}"`);
  }

  if (tag === 'a') {
    // An unrelated tab that can reach back through `window.opener` is a real attack, and the
    // merchant who pasted this markup did not think about it.
    if (!out.some((a) => a.startsWith('rel='))) out.push('rel="noopener noreferrer"');
  }
  if (tag === 'img') {
    if (!out.some((a) => a.startsWith('loading='))) out.push('loading="lazy"');
    if (!out.some((a) => a.startsWith('alt='))) out.push('alt=""');
  }

  return out.length > 0 ? ` ${out.join(' ')}` : '';
}

/**
 * Returns markup safe to hand to `dangerouslySetInnerHTML`.
 *
 * Unbalanced or unknown tags are dropped and their TEXT is kept — a merchant who pasted an
 * embed code should see their words, not a blank block that makes them think the site broke.
 */
export function sanitizeHtml(input: string): string {
  if (!input) return '';

  // Whole dangerous elements go first, contents and all: a `<script>` body is not text.
  const stripped = input.replace(
    /<\s*(script|style|iframe|object|embed|template|noscript|svg|math|form|input|button|select|textarea)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi,
    '',
  );

  const out: string[] = [];
  const open: string[] = [];
  const token = /<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;

  let cursor = 0;
  for (const match of stripped.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > cursor) out.push(escapeText(stripped.slice(cursor, index)));
    cursor = index + match[0].length;

    const closing = Boolean(match[1]);
    const tag = match[2]!.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) continue;

    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;
      // Close everything opened after it too, innermost first — otherwise a stray `</div>`
      // would leave a `<p>` open and swallow the rest of the page into it.
      while (open.length > at) out.push(`</${open.pop()!}>`);
      continue;
    }

    const attributes = sanitiseAttributes(tag, match[3] ?? '');
    if (VOID_TAGS.has(tag)) {
      out.push(`<${tag}${attributes} />`);
    } else {
      out.push(`<${tag}${attributes}>`);
      open.push(tag);
    }
  }

  if (cursor < stripped.length) out.push(escapeText(stripped.slice(cursor)));
  while (open.length > 0) out.push(`</${open.pop()!}>`);

  return out.join('');
}
