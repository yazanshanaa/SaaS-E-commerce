import type { SystemJob } from '@/server/queues';
import { sweepSubscriptions, type SweepCounts } from './lifecycle-sweep';

/**
 * The daily repeatable, registered in `src/worker/index.ts` at 03:00 Asia/Jerusalem.
 *
 * A fixed UTC hour would drift by an hour twice a year with Israeli DST and eventually run during
 * business hours, which for a job that suspends storefronts is not a cosmetic problem.
 *
 * The body lives in `./lifecycle-sweep` so it can be called with an injected clock: proving that
 * a subscription lapses, warns, and is purged on the right days needs fake timers, and a
 * processor that reads `new Date()` internally cannot be tested that way at all.
 */
export default async function process(_ctx: { job: SystemJob }): Promise<SweepCounts> {
  return sweepSubscriptions();
}
