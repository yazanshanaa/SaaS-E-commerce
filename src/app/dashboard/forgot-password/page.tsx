import { MerchantForgotPasswordForm } from '../_components/auth-forms';

/**
 * `app.{DOMAIN}/forgot-password`.
 *
 * The merchant-facing half of password recovery. A1 ships the platform owner's on the admin
 * host, and both have to exist separately because session cookies are host-only.
 */
export const dynamic = 'force-dynamic';

export default function MerchantForgotPasswordPage() {
  return <MerchantForgotPasswordForm />;
}
