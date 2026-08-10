import { ResetPasswordForm } from '../_components/password-forms';

export const dynamic = 'force-dynamic';

/**
 * better-auth's reset callback lands here with `?token=…`, so the token arrives as a search
 * parameter and is handed to the form untouched — it is a one-time credential the API validates,
 * and nothing on this page may store or log it.
 */
export default async function AdminResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.token;
  const token = typeof raw === 'string' && raw.length > 0 ? raw : null;

  return <ResetPasswordForm token={token} />;
}
