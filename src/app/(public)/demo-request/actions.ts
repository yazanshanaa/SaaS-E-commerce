'use server';

import { headers as nextHeaders } from 'next/headers';
import { getClientIp } from '@/server/http/get-client-ip';
import { submitPublicDemoRequest } from '@/server/demo/requests';
import { resolvePublicMessage } from '../_components/messages';
import type { DemoRequestState } from './state';

/**
 * The public form's only mutation.
 *
 * It is unauthenticated by construction — a prospect has no account, and Q1 means there is no way
 * for them to get one. So the three things that usually stand between a POST and the database are
 * absent, and the three that replace them all live behind `submitPublicDemoRequest`: the per-IP rate
 * limit, the zod parse, and a writer that can only INSERT (`app_web` has no SELECT on
 * `demo_requests`). It NEVER creates a tenant.
 *
 * `getClientIp()` is the only IP source (invariant 9), and the headers come from Next rather than
 * from the caller so nothing downstream can be handed a forged bag.
 *
 * The state SHAPE lives in `./state.ts`: a `'use server'` file may export only async functions, so a
 * `const` or a re-exported type here is a build error rather than a tidiness question.
 */

const FIELDS = ['businessName', 'address', 'whatsapp', 'requestedPrefix', 'packKey'] as const;

function readValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = form.get(field);
    if (typeof value === 'string') values[field] = value;
  }
  return values;
}

export async function submitDemoRequestAction(
  _state: DemoRequestState,
  form: FormData,
): Promise<DemoRequestState> {
  const headers = await nextHeaders();
  const values = readValues(form);

  const outcome = await submitPublicDemoRequest(
    {
      // Empty optional fields arrive as '' from a form and must become `undefined`, not a value
      // that fails `min(2)` on a field the prospect deliberately left blank.
      businessName: values.businessName?.trim() || undefined,
      address: values.address ?? '',
      whatsapp: values.whatsapp ?? '',
      requestedPrefix: values.requestedPrefix ?? '',
      packKey: values.packKey?.trim() || undefined,
    },
    { headers, ip: getClientIp({ headers }).ip },
  );

  if (outcome.ok) {
    return { status: 'ok', message: resolvePublicMessage('demo:request.success') };
  }

  return {
    status: 'error',
    message: resolvePublicMessage(`demo:request.errors.${outcome.failure ?? 'unexpected'}`),
    ...(outcome.fieldErrors
      ? {
          fieldErrors: outcome.fieldErrors.map((error) => ({
            field: error.field,
            message: resolvePublicMessage(error.messageKey),
          })),
        }
      : {}),
    values,
  };
}
