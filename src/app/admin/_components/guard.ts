import { redirect } from 'next/navigation';
import { optionalAdminContext, type AdminContext } from '@/server/admin';

/**
 * The guard every authenticated admin screen and every admin server action starts with.
 *
 * It redirects to `/` — the sign-in card — rather than throwing, because an unauthenticated
 * request to an admin URL is an ordinary thing (a bookmark, an expired session) and an error
 * page is the wrong answer to it. Screens do not get a database client without calling this, so
 * "forgot the guard" is not a shape a page can take.
 */
export async function requireAdminPage(): Promise<AdminContext> {
  const ctx = await optionalAdminContext();
  if (!ctx) redirect('/');
  return ctx;
}

/** First value of a search parameter, or undefined. Next hands arrays for repeated keys. */
export function param(
  params: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = params[name];
  if (Array.isArray(value)) return value[0];
  return value && value.length > 0 ? value : undefined;
}

export function pageParam(
  params: Record<string, string | string[] | undefined>,
  name = 'page',
): number {
  const raw = Number(param(params, name) ?? '1');
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}
