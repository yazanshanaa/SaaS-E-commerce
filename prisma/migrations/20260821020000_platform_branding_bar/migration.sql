-- The agency credit bar (2026-08-21, owner-directed): a platform-wide footer line on every
-- storefront — «صمّم وبُرمج بواسطة {name}» — switched on, named and linked from the /plans panel
-- and from nowhere else. Additive, main session, on the existing singleton: exactly the shape
-- platform_settings' own comment promised the NEXT platform-wide constant would take.
--
-- OFF BY DEFAULT. A fresh deployment must not advertise anyone until its owner says so, and the
-- toggle living on this row (not on a plan, not on a capability) is what keeps merchants unable
-- to see it, ask about it, or file a change request against it.

ALTER TABLE "platform_settings" ADD COLUMN "branding_bar_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "platform_settings" ADD COLUMN "branding_bar_name" TEXT;
ALTER TABLE "platform_settings" ADD COLUMN "branding_bar_url" TEXT;

-- Enabled means there is something to render. Without this, a row with the toggle on and both
-- fields empty would put an empty sentence with a dead link on every storefront on the platform.
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_branding_coherent" CHECK (
  "branding_bar_enabled" = false
  OR ("branding_bar_name" IS NOT NULL AND "branding_bar_url" IS NOT NULL)
);
