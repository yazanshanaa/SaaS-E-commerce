import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/server/auth';

/**
 * better-auth's route handler.
 *
 * There is no sign-up endpoint to protect: `emailAndPassword.disableSignUp` is true and the
 * organization plugin's `allowUserToCreateOrganization` is false (Q1). The handler still
 * serves sign-in, sign-out, verification, password reset and 2FA — which is why proxy.ts
 * allow-lists `/api/auth/` on app.*.
 */
export const dynamic = 'force-dynamic';

export const { GET, POST } = toNextJsHandler(auth().handler);
