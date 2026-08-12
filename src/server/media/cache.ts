/**
 * How long a delivered media object may live in a cache — the ONE place the number is decided.
 *
 * It is a leaf module with no imports on purpose. `src/server/legal` interpolates the ceiling into
 * the Arabic privacy policy, and the only other home for these constants was
 * `processors/process-upload.ts`, which imports Sharp — pulling an image pipeline into the Next
 * server so a policy page could quote a number would be an odd way to keep a sentence true.
 *
 * WHY IT IS NOT `immutable`. `max-age=31536000, immutable` is the right header for a
 * content-addressed asset and the wrong one here: a merchant who uploads a photo that happens to
 * show a customer's ID card, notices, and deletes it, has the row and the R2 objects removed —
 * while the URL the storefront already published keeps serving the image from the edge, because
 * `immutable` tells the cache never to revalidate. The same gap outlives a purge, so images
 * certified as erased stay fetchable.
 *
 * Phase 6 cut the stale window from a week to a day. Not because a week was reckless, but because
 * the privacy copy now states this number, and "up to eight days" was not a number worth writing
 * down when two costs nothing: `max-age` is what the perf budget cares about and it did not move.
 * Purging the edge on delete is the complete fix and needs a Cloudflare token scoped for it
 * (docs/DECISIONS.md, Phase 6 — carried forward).
 */

export const CDN_FRESH_SECONDS = 86_400;
export const CDN_STALE_SECONDS = 86_400;

export const CDN_CACHE_CONTROL = `public, max-age=${CDN_FRESH_SECONDS}, stale-while-revalidate=${CDN_STALE_SECONDS}`;

/**
 * The worst case, in days, between deleting an image and the last cache letting go of it.
 *
 * The honest ceiling for the edge AND for an already-loaded browser, since the same header reaches
 * both — which is why the generated policy says "up to N days" rather than "immediately".
 */
export const MEDIA_CACHE_MAX_DAYS = Math.ceil((CDN_FRESH_SECONDS + CDN_STALE_SECONDS) / 86_400);
