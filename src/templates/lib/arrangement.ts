import type { SectionType } from '@/shared/site-contract';
import type { StorefrontContext } from '../view-model';

/**
 * Does the HOME arrangement contain this section?
 *
 * Three separate elements link to `#contact-whatsapp` — the header nav, the footer's quick links
 * and the hero's secondary button — and all three did it unconditionally. On any shop whose
 * arrangement has no contact block (a merchant who entered no contact details at all, or anyone
 * who removed the section in the dashboard), the primary navigation link on every page pointed at
 * an id that does not exist. A browser answers that by doing nothing, which a visitor reads as a
 * broken site rather than as a missing section.
 *
 * `context.sections` is always the HOME arrangement, which is what the `/#…` links target, so
 * this stays correct on `/products` and `/p/{slug}` where the header still renders.
 */
export function hasSection(context: StorefrontContext, type: SectionType): boolean {
  return context.sections.some((section) => section.type === type);
}

/** The specific question all three call sites ask. */
export function hasContactSection(context: StorefrontContext): boolean {
  return hasSection(context, 'contact_whatsapp');
}
