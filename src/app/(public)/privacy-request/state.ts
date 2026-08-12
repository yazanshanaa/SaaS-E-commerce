/**
 * The data-subject form's action state.
 *
 * Its own module for the same reason `demo-request/state.ts` is: a `'use server'` file may export
 * only async functions, so a plain `const` or a type in one is a build error rather than a
 * stylistic question. Splitting it also keeps the client bundle honest — this file imports nothing.
 *
 * The message arrives ALREADY ARABIC, resolved on the server inside the action. Every other surface
 * returns an i18n key and resolves it in the component; the public tree cannot, because one `t()`
 * in a `'use client'` file ships the whole message catalogue to somebody who has no account and is
 * probably on a phone.
 */

export interface PrivacyRequestState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
  /**
   * What was typed, echoed back so a validation failure does not empty the form.
   *
   * `details` is included and the two identifiers are not omitted either — they never leave the
   * browser they came from, and re-typing a paragraph explaining what you want done with your own
   * data is exactly how somebody gives up on the request.
   */
  values?: Record<string, string>;
}

export const PRIVACY_REQUEST_IDLE: PrivacyRequestState = { status: 'idle' };
