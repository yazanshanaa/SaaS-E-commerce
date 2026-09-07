/**
 * «كلما ضغطت على مكان صلاحية لتعديل يرفع الشاشة للبداية» — the scroll jump, and its fix.
 *
 * THE CAUSE. Every one-click control on the admin surface is a `<form action={serverAction}>` whose
 * action ends in `redirect('/accounts/{id}/permissions?ok=…')`. A redirect is a NAVIGATION, and a
 * navigation to a URL with no fragment starts at the top of the document — by specification, in
 * every browser. So an operator flipping the twentieth capability in the matrix, or nudging the
 * ninth section down one place, was thrown back to the page heading after every single click and had
 * to scroll down and find their place again. On the permissions screen, which is twenty-odd rows of
 * toggles that are usually changed several at a time, that is the difference between a usable screen
 * and one people avoid.
 *
 * THE FIX. Give the row a stable `id`, post that id with the form, and put it back on the redirect
 * as a fragment. The browser then scrolls to the element it names — which is the row that was just
 * clicked, already showing its new state. No client component, no `useActionState`, no scroll
 * library, and the forms keep working with JavaScript disabled, which is the property the whole
 * matrix was built around (see the note on `FeatureRowView`).
 *
 * WHY NOT `scroll: false`. That is a `<Link>` and `router.push` option; a server-action `redirect()`
 * has no such control, and the alternative — converting twenty forms into client components that
 * call `router.refresh()` — would trade a one-line fix for a bundle on the operator's slowest screen.
 */

/** Characters a fragment may carry without needing encoding, and that our row ids actually use. */
const SAFE_ANCHOR = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The value posted back as `anchor`, validated.
 *
 * It arrives from a form field, so it is attacker-controllable in the same sense any hidden input
 * is. It is concatenated into a `Location` header, and `#` is not the only character that matters
 * there: a newline would split the header, and a `/` or `?` would change which URL is being
 * redirected to. An allow-list of `[A-Za-z0-9_-]` cannot express any of those, which is why this is
 * a whitelist rather than an escape.
 */
export function safeAnchor(value: string | null | undefined): string | null {
  if (!value) return null;
  return SAFE_ANCHOR.test(value) ? value : null;
}

/**
 * `/accounts/x/permissions` + `?ok=…` + `#cap-colors`.
 *
 * The query comes first because a fragment must be last in a URL — `?ok=…#row` is a query of `ok=…`
 * and a fragment of `row`, while `#row?ok=…` is a fragment of `row?ok=…` and NO query at all, which
 * would silently stop the success notice from ever rendering.
 */
export function backTo(
  path: string,
  result: { ok?: string; error?: string },
  anchor?: string | null,
): string {
  const query = result.error
    ? `?error=${encodeURIComponent(result.error)}`
    : result.ok
      ? `?ok=${encodeURIComponent(result.ok)}`
      : '';

  const fragment = safeAnchor(anchor) ? `#${safeAnchor(anchor)}` : '';
  return `${path}${query}${fragment}`;
}
