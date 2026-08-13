/**
 * Keeps a form's fields populated across a failed submission.
 *
 * React resets every uncontrolled `<form>` field to its `defaultValue` as soon as the bound
 * action's promise SETTLES — successfully or not. `ActionForm`'s actions never throw on a
 * validation failure (they resolve to `{ status: 'error', ... }`), so from React's point of view
 * every submission "succeeds" and the form is wiped on every single mistake: fix the one field
 * the error pointed at, and the merchant or admin comes back to find every OTHER field blank too.
 *
 * The fix has to run on the native `submit` event, before React's action machinery takes over,
 * and it has to mutate the DOM `defaultValue`/`defaultChecked` directly — the React `defaultValue`
 * prop is read once at mount and never reapplied, so nothing declarative reaches an input that is
 * already on the page. Setting the DOM property changes what the native `reset()` algorithm (the
 * exact thing React invokes after the action settles) restores the field to, so the field comes
 * back showing what the user just typed instead of nothing.
 *
 * Deliberately excluded:
 *   - `password` inputs — provider secrets in this app are write-only by design (never re-shown
 *     after saving), and mirroring one into a DOM attribute would leave it sitting in plain text
 *     for devtools/extensions to read.
 *   - `file` inputs — browsers do not allow a script to set their value; nothing to preserve.
 */
export function preserveFormValuesOnSubmit(form: HTMLFormElement): void {
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'password' || el.type === 'file') continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.defaultChecked = el.checked;
      } else {
        el.defaultValue = el.value;
      }
    } else if (el instanceof HTMLTextAreaElement) {
      el.defaultValue = el.value;
    } else if (el instanceof HTMLSelectElement) {
      for (const option of Array.from(el.options)) option.defaultSelected = option.selected;
    }
  }
}
