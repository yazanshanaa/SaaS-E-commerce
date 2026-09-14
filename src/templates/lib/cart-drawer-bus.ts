/**
 * The one channel between "something was added" and "show me the cart".
 *
 * Every large store opens a side drawer the moment a product lands in the cart, and again when the
 * cart icon is pressed. The button that adds, the icon in the header, the tab in the phone bar and
 * the drawer itself are four separate client islands, so they talk through a window event rather
 * than shared React state — the same shape `lib/cart.ts` already uses for the count.
 */

export const CART_DRAWER_EVENT = 'sf:cart-drawer';

export type CartDrawerCommand = 'open' | 'close' | 'toggle';

export function cartDrawer(command: CartDrawerCommand): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CartDrawerCommand>(CART_DRAWER_EVENT, { detail: command }));
}
