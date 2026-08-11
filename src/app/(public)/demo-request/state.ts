/**
 * The form's action state, in its own module.
 *
 * It lives here rather than beside the action because a `'use server'` file may export only async
 * functions — a plain `const` in one is a build error in Next's server-actions compiler, and the
 * type would ride along with it. Splitting them also keeps the client bundle honest: this file has
 * no imports at all, so the form can take the shape without pulling anything server-side across.
 */

export interface DemoRequestState {
  status: 'idle' | 'ok' | 'error';
  /**
   * ARABIC, ALREADY RESOLVED — the one place this surface departs from A1's convention.
   *
   * Every other action in the platform returns an i18n KEY and the client component resolves it.
   * That convention exists so copy stays in the catalogue where the language gate can see it, and it
   * still does: the key is resolved by `t()`, on the server, inside the action. What it buys is that
   * the public page's client bundle imports no i18n at all — and `src/shared/i18n` is a static object
   * of all seven namespace files, so a single `t()` in a `'use client'` component would ship the
   * admin panel's entire message catalogue to a prospect on a phone. Behind a login that is a fair
   * trade; on the one page the platform serves to the open internet it is not.
   */
  message?: string;
  fieldErrors?: Array<{ field: string; message: string }>;
  /**
   * What the prospect typed, echoed back so a validation failure does not empty the form.
   *
   * React resets an uncontrolled form after a form action completes, and re-typing an address and a
   * phone number because one field was wrong is how a lead is lost. The values never leave the
   * browser they came from: they are rendered back as `defaultValue` into the same person's page.
   */
  values?: Record<string, string>;
}

export const DEMO_REQUEST_IDLE: DemoRequestState = { status: 'idle' };
