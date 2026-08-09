import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '@/templates';

/**
 * The `custom_html` sanitiser.
 *
 * This is the only place on a storefront where markup somebody typed reaches the page, so the
 * test file is written as an attack list rather than as a feature list. Every case below is a
 * technique that has worked against a naive blocklist in the wild.
 */

describe('sanitizeHtml keeps the content', () => {
  it('preserves ordinary Arabic formatting', () => {
    const input = '<p>عندنا <strong>عروض</strong> كل خميس</p><ul><li>زيت زيتون</li></ul>';
    expect(sanitizeHtml(input)).toBe(input);
  });

  it('keeps a safe link and hardens it', () => {
    const output = sanitizeHtml('<a href="https://example.com">اضغط هنا</a>');
    expect(output).toContain('href="https://example.com"');
    // An unrelated tab that can reach back through window.opener is a real attack.
    expect(output).toContain('rel="noopener noreferrer"');
  });

  it('keeps a merchant’s words when they paste an embed we cannot render', () => {
    // Dropping the block entirely would make them think the site broke.
    const output = sanitizeHtml('<marquee>تخفيضات</marquee>');
    expect(output).toContain('تخفيضات');
    expect(output).not.toContain('<marquee');
  });

  it('defaults an image to lazy with an empty alt', () => {
    const output = sanitizeHtml('<img src="/media/x.webp">');
    expect(output).toContain('loading="lazy"');
    expect(output).toContain('alt=""');
  });
});

describe('sanitizeHtml removes everything that can execute', () => {
  const attacks: Array<[string, string]> = [
    ['a script element', '<script>alert(1)</script>'],
    ['a script body without a closing tag', '<script>alert(1)'],
    ['an inline handler', '<div onclick="alert(1)">x</div>'],
    ['a handler on an allowed attribute holder', '<a href="/x" onmouseover="alert(1)">x</a>'],
    ['an image error handler', '<img src=x onerror=alert(1)>'],
    ['a javascript: URL', '<a href="javascript:alert(1)">x</a>'],
    ['a javascript: URL with a tab inside the scheme', '<a href="java\tscript:alert(1)">x</a>'],
    ['a data: URL', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'],
    ['an svg payload', '<svg onload="alert(1)"></svg>'],
    ['an iframe', '<iframe src="https://evil.example"></iframe>'],
    ['a style element', '<style>body{display:none}</style>'],
    ['a style attribute', '<div style="position:fixed;inset:0">x</div>'],
    ['a form', '<form action="https://evil.example"><input name="p"></form>'],
    ['an object', '<object data="evil.swf"></object>'],
  ];

  for (const [name, payload] of attacks) {
    it(`drops ${name}`, () => {
      const output = sanitizeHtml(payload);
      expect(output).not.toMatch(/<script/i);
      expect(output).not.toMatch(/<iframe/i);
      expect(output).not.toMatch(/<svg/i);
      expect(output).not.toMatch(/<style/i);
      expect(output).not.toMatch(/<form/i);
      expect(output).not.toMatch(/<object/i);
      expect(output).not.toMatch(/\son\w+\s*=/i);
      expect(output.toLowerCase()).not.toContain('javascript:');
      expect(output.toLowerCase()).not.toContain('data:text/html');
      expect(output).not.toMatch(/\sstyle\s*=/i);
    });
  }

  it('escapes stray angle brackets instead of letting them open a tag', () => {
    expect(sanitizeHtml('5 < 6 && 7 > 6')).toBe('5 &lt; 6 &amp;&amp; 7 &gt; 6');
  });

  it('closes what it opens, so a stray tag cannot swallow the rest of the page', () => {
    const output = sanitizeHtml('<div><p>نص');
    expect(output).toBe('<div><p>نص</p></div>');
  });

  it('ignores a closing tag that was never opened', () => {
    expect(sanitizeHtml('نص</div>')).toBe('نص');
  });

  it('unwinds correctly when tags are crossed', () => {
    // `<p><strong>x</p></strong>` must not leave <strong> open past the paragraph.
    const output = sanitizeHtml('<p><strong>نص</p></strong>');
    expect(output).toBe('<p><strong>نص</strong></p>');
  });

  it('is idempotent — sanitising sanitised output changes nothing', () => {
    const once = sanitizeHtml('<p>عرض <a href="https://a.example">هنا</a></p><script>x</script>');
    expect(sanitizeHtml(once)).toBe(once);
  });

  it('handles an empty or absent value without throwing', () => {
    expect(sanitizeHtml('')).toBe('');
  });
});
