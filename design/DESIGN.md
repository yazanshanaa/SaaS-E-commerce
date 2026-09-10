# Design contract — Souq Bartaa

**Identity.** The platform chrome reads as an *instrument a shopkeeper reads their business off* —
not a marketing site with tables bolted on. Dense, quiet, high-contrast where the data is and
nowhere else.

**Provenance.** This is not a new identity. `design/design.json` is the machine-readable form of
`DESIGN_BRIEF.md` («مرصد» / Marsad), approved by the owner from Direction C of
`docs/design-directions.html` on 2026-08-30. To change a decision, amend `DESIGN_BRIEF.md` first.

**Scope.** Two private surfaces only: Super Admin («سجلّ») and Merchant Dashboard («ورشة»). The
nine storefront templates are governed separately — each ships its own frozen token set, and
tenant colour customisation writes tokens only, behind an automatic WCAG AA contrast check.

**Type.** Alexandria 700 for headings; IBM Plex Sans Arabic 400/700 for body, tables and KPI
values (it has the dependable tabular figures a column of money needs). Both self-hosted and
Arabic-subset. Zain is deliberately excluded from the chrome — it is a storefront face.

**Colour.** Dark by default, light a full peer. Near-black green ground, one mint accent used only
for data and state — never for page furniture. The accent is not one value across modes:
`#5FD3A8` is 9.4:1 on the dark ground and 1.7:1 on white, so light mode resolves its own.
`tests/unit/chrome-contrast.test.ts` fails the build on any pair under threshold.

**Three signature elements**, each identifiable with the logo cropped out: the inline sparkline on
every KPI card; the corner bloom on the active card only; the state hairline on a card's
inline-start edge, always paired with a text label and never hue alone.

**No hero anywhere.** Every page opens on `PageHead` and goes straight to data.

**Known gap.** Form-control borders draw from the rule token (~1.6:1) against WCAG 1.4.11's 3:1
for component boundaries. Inherited from Phase 1; it needs a rendered element to measure, so it
belongs to the axe-core e2e pass rather than the token test.
