'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * The cart itself (Phase 8, item 2): localStorage PER TENANT, and nothing server-side until
 * checkout. No `Cart` table exists in the schema — there is nothing here for the platform to
 * lose, leak or have to purge, and "add to cart" never touches the network.
 *
 * Tenant-scoped storage KEY is defence in depth rather than the isolation boundary itself: every
 * tenant already answers on its own hostname, so the browser's own origin isolation already
 * keeps one shop's cart out of another's — but a key that did not say which tenant it belonged
 * to would still be a landmine for local development against multiple tenants on one host.
 *
 * A `CustomEvent` (not just the native `storage` event) is what keeps the floating cart badge,
 * the add-to-cart button and the cart page in sync: `storage` fires on every tab EXCEPT the one
 * that made the write, so a merchant with the cart page open in the same tab they just clicked
 * "أضف للسلة" on would see a stale count without it.
 */

export interface CartLine {
  productSlug: string;
  quantity: number;
}

const CART_EVENT = 'sb-cart-changed';
const MAX_QUANTITY_PER_LINE = 99;
const MAX_LINES = 50;

function storageKey(tenantId: string): string {
  return `sb-cart:v1:${tenantId}`;
}

function isCartLine(value: unknown): value is CartLine {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.productSlug === 'string' &&
    candidate.productSlug.length > 0 &&
    typeof candidate.quantity === 'number' &&
    Number.isInteger(candidate.quantity) &&
    candidate.quantity > 0
  );
}

export function readCart(tenantId: string): CartLine[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(tenantId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCartLine).slice(0, MAX_LINES);
  } catch {
    return [];
  }
}

function writeCart(tenantId: string, lines: CartLine[]): CartLine[] {
  const clamped = lines.slice(0, MAX_LINES);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(storageKey(tenantId), JSON.stringify(clamped));
    } catch {
      // Storage full or unavailable (private mode) — the in-memory state the caller already has
      // is what the UI shows; nothing durable, but nothing thrown at a customer either.
    }
    window.dispatchEvent(new CustomEvent(CART_EVENT, { detail: { tenantId } }));
  }
  return clamped;
}

export function addToCart(tenantId: string, productSlug: string, quantity: number): CartLine[] {
  const lines = readCart(tenantId);
  const existing = lines.find((line) => line.productSlug === productSlug);
  if (existing) {
    existing.quantity = Math.min(MAX_QUANTITY_PER_LINE, existing.quantity + quantity);
  } else {
    lines.push({ productSlug, quantity: Math.min(MAX_QUANTITY_PER_LINE, quantity) });
  }
  return writeCart(tenantId, lines);
}

export function setCartQuantity(tenantId: string, productSlug: string, quantity: number): CartLine[] {
  const lines = readCart(tenantId);
  if (quantity <= 0) {
    return writeCart(tenantId, lines.filter((line) => line.productSlug !== productSlug));
  }
  const clampedQuantity = Math.min(MAX_QUANTITY_PER_LINE, quantity);
  const existing = lines.find((line) => line.productSlug === productSlug);
  if (existing) existing.quantity = clampedQuantity;
  else lines.push({ productSlug, quantity: clampedQuantity });
  return writeCart(tenantId, lines);
}

export function removeFromCart(tenantId: string, productSlug: string): CartLine[] {
  return writeCart(tenantId, readCart(tenantId).filter((line) => line.productSlug !== productSlug));
}

export function clearCart(tenantId: string): void {
  writeCart(tenantId, []);
}

export function cartCount(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export interface UseCartResult {
  lines: CartLine[];
  count: number;
  add: (productSlug: string, quantity?: number) => void;
  setQuantity: (productSlug: string, quantity: number) => void;
  remove: (productSlug: string) => void;
  clear: () => void;
}

const EMPTY: CartLine[] = [];
/** One cached snapshot per tenant, so `getSnapshot` returns a REFERENCE-STABLE array when
 *  nothing actually changed — `useSyncExternalStore` re-renders on every call whose result is
 *  not `Object.is`-equal to the last one, and `readCart` parses fresh JSON on every call. */
const snapshotCache = new Map<string, CartLine[]>();

function getSnapshot(tenantId: string): CartLine[] {
  const fresh = readCart(tenantId);
  const cached = snapshotCache.get(tenantId);
  if (cached && JSON.stringify(cached) === JSON.stringify(fresh)) return cached;
  snapshotCache.set(tenantId, fresh);
  return fresh;
}

function subscribe(tenantId: string, onStoreChange: () => void): () => void {
  function onChange(event: Event): void {
    const detail = (event as CustomEvent<{ tenantId: string }>).detail;
    if (detail && detail.tenantId !== tenantId) return;
    onStoreChange();
  }
  window.addEventListener(CART_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CART_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/**
 * The shared read model every cart-aware client component subscribes to.
 *
 * `useSyncExternalStore`, not a `useState` + `useEffect` pair reading `localStorage` on mount:
 * this is precisely the API React ships for "read an external mutable store and re-render when
 * it changes." It is also what keeps this hydration-safe FOR FREE — React renders the SERVER
 * snapshot (`EMPTY`) on the client's first pass to match the SSR markup exactly, then re-renders
 * from the real snapshot once mounted, with no manual "hydrated" flag anywhere in this module.
 */
export function useCart(tenantId: string): UseCartResult {
  const lines = useSyncExternalStore(
    useCallback((onStoreChange) => subscribe(tenantId, onStoreChange), [tenantId]),
    () => getSnapshot(tenantId),
    () => EMPTY,
  );

  const add = useCallback(
    (productSlug: string, quantity = 1) => {
      addToCart(tenantId, productSlug, quantity);
    },
    [tenantId],
  );
  const setQuantity = useCallback(
    (productSlug: string, quantity: number) => {
      setCartQuantity(tenantId, productSlug, quantity);
    },
    [tenantId],
  );
  const remove = useCallback(
    (productSlug: string) => {
      removeFromCart(tenantId, productSlug);
    },
    [tenantId],
  );
  const clear = useCallback(() => clearCart(tenantId), [tenantId]);

  return { lines, count: cartCount(lines), add, setQuantity, remove, clear };
}
