'use server';

import { headers as nextHeaders } from 'next/headers';
import { getEnv } from '@/env';
import { hashIp } from '@/server/crypto';
import { submitDsrRequest } from '@/server/dsr';
import { getClientIp } from '@/server/http/get-client-ip';
import { logger } from '@/server/logger';
import { consumeSlot } from '@/server/rate-limit';
import { t } from '@/shared/i18n';
import type { PrivacyRequestState } from './state';

/**
 * The data-subject box's only mutation, and it is unauthenticated by necessity.
 *
 * Three of the five subject classes have no account: a storefront visitor, a push subscriber and a
 * demo prospect. The last of those is the reason docs/PHASES.md names this box explicitly — their
 * phone number and physical address sit in a global table and they have no other route to reach us.
 * Putting a login in front of the form would make the right the policy grants unexercisable by
 * precisely the people the policy is about.
 *
 * So the three things that usually stand between a POST and the database are gone, and three
 * others replace them: a per-IP rate limit, a zod parse, and a writer that can only INSERT —
 * `dsr_public_insert` grants app_web INSERT and nothing else, which is why `submitDsrRequest` uses
 * `createMany`. That last one is not a detail: `create()` issues INSERT ... RETURNING, RETURNING
 * needs SELECT, and SELECT here is super-admin only. The confirmation screen therefore has no
 * reference number to show, and does not invent one.
 */

const FIELDS = [
  'subjectKind',
  'kind',
  'subjectEmail',
  'subjectPhone',
  'tenantRef',
  'details',
] as const;

function readValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = form.get(field);
    if (typeof value === 'string') values[field] = value;
  }
  return values;
}

export async function submitPrivacyRequestAction(
  _state: PrivacyRequestState,
  form: FormData,
): Promise<PrivacyRequestState> {
  const values = readValues(form);
  const headers = await nextHeaders();
  const { ip } = getClientIp({ headers });

  /**
   * Charged BEFORE validation, and it FAILS OPEN — the same two decisions the demo form made, for
   * the same reason inverted. Charging first means a script cannot spend the budget on parse
   * errors; failing open means a Redis blink cannot silently swallow a deletion request, which
   * would surface as nothing at all: an empty queue looks exactly like a quiet week.
   */
  const limit = await consumeSlot({
    key: `dsr:submit:${hashIp(ip ?? 'unknown')}`,
    limit: getEnv().RATE_LIMIT_PUBLIC_FORM_PER_HOUR,
    windowSeconds: 3_600,
  });

  if (!limit.allowed) {
    return {
      status: 'error',
      message: t('common', 'privacyRequest.errors.rateLimited'),
      values,
    };
  }

  try {
    await submitDsrRequest({
      subjectKind: values.subjectKind,
      kind: values.kind,
      subjectEmail: values.subjectEmail?.trim() || undefined,
      subjectPhone: values.subjectPhone?.trim() || undefined,
      tenantRef: values.tenantRef?.trim() || undefined,
      details: values.details ?? '',
    });
  } catch (error) {
    /**
     * One generic Arabic refusal, and the reason only in the log.
     *
     * A zod issue path here would name the field, which is helpful — but the failure that actually
     * happens is "no email and no phone", and the schema expresses that as a refinement on
     * `subjectEmail`, which would tell somebody who gave a phone number that their email is wrong.
     * The copy says the true thing instead. Nothing about the submitted values is logged: this is a
     * message a person wrote about their own personal data.
     */
    const invalid = error instanceof Error && error.name === 'ZodError';
    if (!invalid) {
      logger().error({ error: (error as Error).message }, 'data-subject request could not be stored');
    }

    return {
      status: 'error',
      message: t('common', invalid ? 'privacyRequest.errors.contact' : 'privacyRequest.errors.unexpected'),
      values,
    };
  }

  return { status: 'ok', message: t('common', 'privacyRequest.success') };
}
