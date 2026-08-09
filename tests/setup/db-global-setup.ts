import { startTestDatabase } from './postgres-harness';

/**
 * One cluster for the whole integration project. Vitest tears it down after the last file.
 */
let stop: (() => Promise<void>) | undefined;

export async function setup(): Promise<void> {
  const harness = await startTestDatabase();
  stop = harness.stop;
}

export async function teardown(): Promise<void> {
  await stop?.();
}
