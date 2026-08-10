import type { DemoPack, PackKey } from '@/server/demo/types';
import clothing from '@/server/demo/packs/clothing.json';
import food from '@/server/demo/packs/food.json';
import industrial from '@/server/demo/packs/industrial.json';

/**
 * The frozen packs, resolved by key.
 *
 * `createDemo` writes the Site from the pack's identity block before handing the transaction to
 * B3's content builder, so the LIFECYCLE half needs to read a pack — which means somebody has to
 * own the registry, and B1 lands first.
 *
 * B3 should import `DEMO_PACKS` from here for its pack picker rather than building a second
 * loader: two independent readers of the same frozen JSON is how the picker ends up offering a
 * pack that creation cannot resolve. The DATA stays frozen either way (`src/server/demo/packs/**`
 * is reserved in the ownership checker); this file only indexes it.
 *
 * Static imports, not `readFile`: the packs ship inside the Next server bundle and the worker
 * bundle, and a runtime path lookup would work in development and fail in the container.
 */

export const DEMO_PACKS: Record<PackKey, DemoPack> = {
  clothing: clothing as DemoPack,
  industrial: industrial as DemoPack,
  food: food as DemoPack,
};

export const DEMO_PACK_KEYS = Object.keys(DEMO_PACKS) as PackKey[];

export type DemoPackKey = PackKey;

export function isDemoPackKey(value: string): value is PackKey {
  return Object.prototype.hasOwnProperty.call(DEMO_PACKS, value);
}

export class UnknownDemoPackError extends Error {
  constructor(readonly packKey: string) {
    super(`Unknown demo pack: ${packKey}. Known packs: ${DEMO_PACK_KEYS.join(', ')}.`);
    this.name = 'UnknownDemoPackError';
  }
}

/** Throws rather than falling back to a default pack: a demo of the wrong trade is worse. */
export function demoPack(packKey: string): DemoPack {
  if (!isDemoPackKey(packKey)) throw new UnknownDemoPackError(packKey);
  return DEMO_PACKS[packKey];
}
