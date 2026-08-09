/**
 * Who is executing, from the database's point of view.
 *
 * `app.actor_role` is set SERVER-SIDE ONLY, after a verified session. Nothing reads it from a
 * header, a cookie or a request body — a client that sends `x-actor-role: super_admin` changes
 * nothing, and tests/integration/spoofed-actor-role.test.ts proves it.
 *
 * The only value with cross-tenant power is `super_admin`, and it is the ONLY legitimate
 * cross-tenant read path over HTTP: an HTTP request never runs as the app_system database role.
 */
export const ACTOR_ROLES = ['super_admin', 'owner', 'staff', 'system', 'public'] as const;

export type ActorRole = (typeof ACTOR_ROLES)[number];

/**
 * Branded so an ActorRole cannot be conjured from a plain string. The only constructors are
 * `verifiedActor()` (called after a session check) and the two well-known constants below.
 */
declare const verified: unique symbol;

export interface Actor {
  readonly role: ActorRole;
  readonly userId: string | null;
  readonly [verified]: true;
}

function make(role: ActorRole, userId: string | null): Actor {
  return { role, userId } as Actor;
}

/**
 * The ONLY way to build an actor with a real role. Call it with values that came out of a
 * verified session — never with anything derived from request input.
 */
export function verifiedActor(role: ActorRole, userId: string | null): Actor {
  if (!ACTOR_ROLES.includes(role)) {
    throw new Error(`Unknown actor role: ${role}`);
  }
  return make(role, userId);
}

/** An unauthenticated request: a storefront visitor, the public demo form, an export link. */
export const PUBLIC_ACTOR: Actor = make('public', null);

/** Background work: workers, sweeps, the purge. Never granted cross-tenant reads. */
export const SYSTEM_ACTOR: Actor = make('system', null);

export function isSuperAdmin(actor: Actor): boolean {
  return actor.role === 'super_admin';
}
