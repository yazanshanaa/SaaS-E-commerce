/**
 * «رابط الموقع على الخريطة» — a pasted map link, turned into the coordinates the storefront stores.
 *
 * WHY THIS EXISTS (2026-09-06, owner-directed). Both location forms — the merchant's `/settings` and
 * the operator's `/accounts/{id}/content` — asked for `mapLat` and `mapLng` as two bare decimal
 * boxes. Nobody outside this codebase knows their own shop's latitude. What a merchant actually has
 * is the link Google Maps or Waze put on their clipboard when they pressed «مشاركة», and every one
 * of those links carries the coordinates in it. Asking for the numbers instead of the link is asking
 * the merchant to do a conversion the machine can do, and the observed outcome is that the field
 * stays empty and the shop has no map.
 *
 * So the FORMS take a link and this module extracts the pair. The COLUMNS do not change: `mapLat`
 * and `mapLng` are still what is stored, still what `resolveMapTarget` prefers, and still what the
 * Waze deep link navigates to. Nothing downstream of the form knows a link was ever involved.
 *
 * IT IS PURE AND OFFLINE. No fetch, no redirect-following, no network at all — which is the whole
 * reason a shortened `maps.app.goo.gl/…` cannot be resolved here and is refused with a sentence
 * telling the merchant how to get the long one. Following a user-supplied URL from a server action
 * is an SSRF, and «open the link and copy what's in the address bar» is a thing a shop owner can do.
 */

/** What `parseMapLink` understood, or why it did not. */
export type MapLinkResult =
  | { ok: true; lat: number; lng: number }
  /** A shortened link (`maps.app.goo.gl/…`), whose coordinates are behind a redirect we do not follow. */
  | { ok: false; reason: 'shortened' }
  /** A real map link that names a place instead of a point — «…/search/?api=1&query=برطعة». */
  | { ok: false; reason: 'noCoordinates' }
  | { ok: false; reason: 'unrecognised' };

/**
 * Latitude is ±90 and longitude is ±180, and BOTH have to be checked here rather than left to the
 * database.
 *
 * The failure this prevents is not a crash. `@-33.8,151.2` in a Google URL is a real place; the same
 * two numbers arriving the other way round from a hand-edited link puts a shop in Bartaa in the
 * middle of the Pacific, and a map button that opens the wrong continent looks like a working
 * feature. A longitude of 151 in a latitude slot is arithmetically impossible, so it is catchable.
 */
function isLat(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= 90;
}

function isLng(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= 180;
}

function pair(latText: string, lngText: string): MapLinkResult | null {
  const lat = Number(latText);
  const lng = Number(lngText);
  if (!isLat(lat) || !isLng(lng)) return null;
  // 0,0 is Null Island: it is what an empty template variable resolves to, never a shop.
  if (lat === 0 && lng === 0) return null;
  return { ok: true, lat, lng };
}

/** `32.4746` / `-33.8` / `32` — a signed decimal, and nothing else. */
const NUMBER = String.raw`-?\d{1,3}(?:\.\d+)?`;

/**
 * ORDER IS SIGNIFICANT, AND SPECIFIC BEATS LOOSE.
 *
 * The first draft put the path pattern first and it was wrong on real links, in two ways that both
 * end with a shop pinned in the wrong country:
 *
 *   - `/maps/place/12,34-street/@32.4746,35.1234,17z` — a street number in a place NAME is a
 *     `/`-preceded comma-separated pair, so a loose `[/@](n),(n)` matched `12,34` and returned
 *     Sudan while the real `@32.47…` sat untouched three segments later.
 *   - `/maps/dir/32.1,35.1/32.4746,35.1234` — a directions link returns the ORIGIN, which is
 *     wherever the merchant happened to be standing when they shared it.
 *
 * So the explicit forms — Google's own `!3d…!4d…` place payload, then the named query parameters,
 * then an `@`-anchored or zoom-anchored path pair — are tried before anything loose, and the loose
 * one is gone entirely: every form that carries coordinates carries them with a marker.
 */
const PATTERNS: RegExp[] = [
  // Google's `!3d32.47!4d35.12` place payload — the most explicit thing in any share URL.
  new RegExp(String.raw`!3d(${NUMBER})!4d(${NUMBER})`, 'g'),
  // ?q= ?query= ?ll= ?center= ?destination= ?daddr= ?sll=  (Google, Waze, Apple)
  new RegExp(
    String.raw`[?&](?:q|query|ll|center|destination|daddr|sll)=(${NUMBER})(?:,|%2C)(${NUMBER})`,
    'gi',
  ),
  /*
    OpenStreetMap's share panel: `?mlat=32.47&mlon=35.12`. The two keys are separate parameters and
    OSM emits them in this order, but `[\s\S]*?` between them is lazy, so an intervening `&zoom=17`
    costs nothing and a reversed pair simply does not match rather than mis-pairing.
  */
  new RegExp(String.raw`[?&]mlat=(${NUMBER})[\s\S]*?[?&]mlon=(${NUMBER})`, 'gi'),
  // google.com/maps/@32.4746,35.1234,17z  and  /maps/place/…/@32.4746,35.1234,17z/…
  new RegExp(String.raw`@(${NUMBER}),(${NUMBER})(?:,[\d.]+z)?(?=[/?#]|$)`, 'g'),
  // A path pair that carries a zoom token, which nothing but a map coordinate does.
  new RegExp(String.raw`/(${NUMBER}),(${NUMBER}),[\d.]+z`, 'g'),
  // OpenStreetMap's address bar: #map=17/32.4746/35.1234
  new RegExp(String.raw`#map=[\d.]+/(${NUMBER})/(${NUMBER})`, 'g'),
  // A bare paste: "32.4746, 35.1234". People copy this out of the coordinates readout too.
  new RegExp(String.raw`^\s*(${NUMBER})\s*,\s*(${NUMBER})\s*$`, 'g'),
];

/** Hosts we recognise as maps, for telling "no coordinates in it" from "not a map link". */
const MAP_HOSTS = ['google.com/maps', 'maps.google.', 'waze.com', 'openstreetmap.org', 'apple.com/maps'];

/** Hosts whose short form carries an opaque id instead of coordinates. */
const SHORTENERS = ['maps.app.goo.gl', 'goo.gl', 'g.co', 'waze.com/ul/h', 'bit.ly'];

/**
 * Pull `lat`/`lng` out of a pasted map link.
 *
 * Deliberately NOT restricted to Google and Waze hostnames. Apple Maps, OpenStreetMap, Bing and
 * every «شارك الموقع» button in a messaging app produce something with a coordinate pair in it, and
 * a host allow-list would refuse links that are perfectly readable — for no security gain, because
 * nothing here dereferences the URL. What is validated is the NUMBERS, which is the part that can
 * put a shop in the wrong hemisphere.
 */
export function parseMapLink(input: string): MapLinkResult {
  const value = input.trim();
  if (!value) return { ok: false, reason: 'unrecognised' };

  for (const pattern of PATTERNS) {
    /**
     * EVERY match of each pattern, not just the first.
     *
     * `exec` without `g` returns one match, so a pair that fails the range check took the pattern's
     * whole turn: `/maps/place/200,300-Street/@32.4746,35.1234,17z` rejected `200,300` — correctly,
     * 200 is not a latitude — and then gave up on a link whose real coordinates were right there.
     * `matchAll` lets a bad candidate be skipped rather than ending the attempt.
     *
     * `!== undefined` rather than a truthiness test on the captures: a captured `"0"` is falsy, and
     * `?q=0,35.12` is a real place on the Greenwich meridian. Null Island (0,0) is rejected by
     * `pair` on its own merits, which is a different question from "did this group capture".
     */
    for (const match of value.matchAll(pattern)) {
      if (match[1] === undefined || match[2] === undefined) continue;
      const result = pair(match[1], match[2]);
      if (result) return result;
    }
  }

  const lower = value.toLowerCase();
  if (SHORTENERS.some((host) => lower.includes(host))) return { ok: false, reason: 'shortened' };

  /**
   * A GENUINE map link that simply has no coordinates in it — `…/maps/search/?api=1&query=برطعة`,
   * which is what you get from sharing a place searched by name. Telling that merchant «تأكد إنه
   * رابط خريطة» is telling them the thing they are looking at is not the thing they are looking at.
   * Its own reason, so the copy can point them at the address box instead, which exists for this.
   */
  if (MAP_HOSTS.some((host) => lower.includes(host))) return { ok: false, reason: 'noCoordinates' };

  return { ok: false, reason: 'unrecognised' };
}

/**
 * The link to SHOW a merchant for coordinates already on file, so the field they are editing is not
 * blank on a shop that has a location.
 *
 * `google.com/maps/search/?api=1&query=…` rather than the `/@lat,lng,17z` form: the `api=1` endpoint
 * is the documented, stable one, it round-trips through `parseMapLink` above, and it drops a pin
 * rather than merely centring the viewport — which is what the merchant is trying to confirm.
 */
export function mapLinkFor(lat: number | null, lng: number | null): string | null {
  if (lat === null || lng === null || !isLat(lat) || !isLng(lng)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
