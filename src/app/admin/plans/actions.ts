'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  FEATURE_KINDS,
  checkbox,
  deletePlan,
  parseFeatureValue,
  savePlan,
  text,
  textList,
  type ActionState,
  type PlanMatrixInput,
} from '@/server/admin';
import { setBrandingBar, setOrderEditWindowMaxMinutes } from '@/server/platform-settings';
import { CAPABILITY_KEYS, FEATURE_KEYS } from '@/shared/features';
import { requireAdminPage } from '../_components/guard';

/**
 * Plan CRUD.
 *
 * The two matrices are read out of the same form as the prices, because they are one editorial
 * act: "what does this plan include" is not a separate screen from "what does it cost". The
 * service invalidates the entitlement cache for every tenant on the plan afterwards — without
 * that, an admin raises a limit here and the merchant keeps hitting the old one.
 */
function readMatrix(form: FormData): PlanMatrixInput {
  const features: PlanMatrixInput['features'] = {};

  for (const featureKey of FEATURE_KEYS) {
    const kind = FEATURE_KINDS[featureKey];
    const parsed = parseFeatureValue(featureKey, {
      boolean: checkbox(form, `feature-${featureKey}`),
      text: text(form, `feature-${featureKey}`),
      list: textList(form, `feature-${featureKey}`),
      unlimited: checkbox(form, `unlimited-${featureKey}`),
    });

    if (parsed.ok) {
      features[featureKey] = parsed.value;
      continue;
    }

    // A template list can legitimately arrive empty from a plan form the admin has not touched;
    // anything else that fails to parse is left alone rather than written as a guess.
    if (kind === 'templates') continue;
  }

  const capabilities: PlanMatrixInput['capabilities'] = {};
  for (const capabilityKey of CAPABILITY_KEYS) {
    capabilities[capabilityKey] = {
      visible: checkbox(form, `cap-visible-${capabilityKey}`),
      editableBy: text(form, `cap-editable-${capabilityKey}`) === 'merchant' ? 'merchant' : 'admin',
    };
  }

  return { features, capabilities };
}

function planInput(form: FormData) {
  const sortOrder = Number(text(form, 'sortOrder') || '0');

  return {
    key: text(form, 'key'),
    name: text(form, 'name'),
    description: text(form, 'description'),
    priceMonthlyAgorot: text(form, 'priceMonthly'),
    priceYearlyAgorot: text(form, 'priceYearly'),
    setupFeeAgorot: text(form, 'setupFee'),
    hidden: checkbox(form, 'hidden'),
    active: checkbox(form, 'active'),
    sortOrder: Number.isInteger(sortOrder) ? sortOrder : 0,
  };
}

export async function createPlanAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();

  const result = await savePlan(ctx, planInput(form), readMatrix(form), { create: true });
  if ('state' in result) return result.state;

  revalidatePath('/plans');
  redirect(`/plans/${result.planKey}?ok=admin:plans.created`);
}

export async function updatePlanAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();

  const result = await savePlan(ctx, planInput(form), readMatrix(form), { create: false });
  if ('state' in result) return result.state;

  revalidatePath('/plans');
  revalidatePath(`/plans/${result.planKey}`);
  return { status: 'ok', messageKey: 'admin:plans.updated' };
}

export async function deletePlanAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const key = text(form, 'key');

  const state = await deletePlan(ctx, key);
  revalidatePath('/plans');

  if (state) {
    redirect(`/plans/${key}?error=${encodeURIComponent(state.messageKey ?? 'admin:errors.unexpected')}`);
  }

  redirect('/plans?ok=admin:plans.deleted');
}

/**
 * Phase 8, item 9: the platform-wide cap on `OrderSettings.editWindowMinutes`. Lives on this
 * page rather than a screen of its own — this is the one existing surface where a super admin
 * already edits a platform-wide numeric policy, and `setOrderEditWindowMaxMinutes` is itself the
 * audited, invariant-3-compliant write (src/server/platform-settings.ts).
 */
export async function savePlatformSettingsAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const minutes = Number(text(form, 'orderEditWindowMaxMinutes'));

  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10_080) {
    redirect('/plans?error=admin:errors.invalidValue');
  }

  await setOrderEditWindowMaxMinutes(ctx, minutes);
  revalidatePath('/plans');
  redirect('/plans?ok=admin:account.saved');
}

/**
 * The agency credit bar (2026-08-21). Same audited, owner-only door as the cap above — and the
 * COHERENCE rule is enforced here as well as by the database CHECK: switching the bar on with an
 * empty name or link is refused with a message, not saved as a broken footer on every shop.
 */
export async function saveBrandingBarAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const enabled = checkbox(form, 'brandingBarEnabled');
  const name = text(form, 'brandingBarName').trim() || null;
  const rawUrl = text(form, 'brandingBarUrl').trim() || null;

  // http(s) only. A javascript: URL in a link rendered on every storefront on the platform is
  // exactly the kind of thing a write-side check exists for.
  let url: string | null = null;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
      url = parsed.toString();
    } catch {
      redirect('/plans?error=admin:platformSettings.branding.invalidUrl');
    }
  }

  if (enabled && (!name || !url)) {
    redirect('/plans?error=admin:platformSettings.branding.incomplete');
  }

  await setBrandingBar(ctx, { enabled, name, url });
  revalidatePath('/plans');
  redirect('/plans?ok=admin:account.saved');
}
