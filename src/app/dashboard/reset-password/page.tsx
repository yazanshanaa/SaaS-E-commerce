import { MerchantResetPasswordForm } from '../_components/auth-forms';

/**
 * `app.{DOMAIN}/reset-password` — where every merchant invitation lands.
 *
 * A1's `sendOwnerPasswordLink` and this track's staff invitation both pass
 * `absoluteUrl(platformHost('app'), '/reset-password')` as better-auth's `redirectTo`, so
 * without this page every account ever created on this platform would receive a working reset
 * link to a 404. It is B2's because it is on B2's surface, and it is the reason a merchant can
 * get in at all.
 *
 * The token arrives as a search parameter and is handed to the form untouched — it is a
 * one-time credential the API validates, and nothing on this page may store or log it.
 */
export const dynamic = 'force-dynamic';

export default async function MerchantResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.token;
  const token = typeof raw === 'string' && raw.length > 0 ? raw : null;

  return <MerchantResetPasswordForm token={token} />;
}
