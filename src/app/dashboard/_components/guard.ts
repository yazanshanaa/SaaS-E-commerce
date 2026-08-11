import { notFound, redirect } from 'next/navigation';
import {
  optionalMerchantContext,
  merchantCan,
  type MerchantContext,
  type MerchantScope,
} from '../_lib/context';

/**
 * The guard every authenticated merchant screen and every server action starts with.
 *
 * Unauthenticated redirects to `/` — the sign-in card — rather than throwing, because an
 * unauthenticated request to a dashboard URL is an ordinary thing (a bookmark, an expired
 * session) and an error page is the wrong answer to it.
 *
 * A REFUSED SCOPE IS A 404, not a 403, and that is the whole of "a staff user cannot reach any
 * billing screen by URL". The two refusals `checkMerchantAccess` distinguishes — wrong role,
 * plan does not include it — deliberately look identical from outside: telling a staff member
 * that a screen exists and is not theirs is an inventory of what to go looking for, and telling
 * a basic-plan merchant that an analytics screen exists behind a plan is a sales pitch nobody
 * asked this page to make.
 *
 * Screens do not get a database client without calling this, so "forgot the guard" is not a
 * shape a page can take.
 */
export async function requireMerchantPage(scope?: MerchantScope): Promise<MerchantContext> {
  const ctx = await optionalMerchantContext();
  if (!ctx) redirect('/');

  if (scope && !(await merchantCan(ctx, scope))) notFound();

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
