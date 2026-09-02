/**
 * `src/server/tax` — Phase 9 / Track D's invoicing settings.
 *
 * A folder of its own rather than a file inside `src/server/delivery`, even though one track built
 * both: the two share a dashboard section in the merchant's head and nothing at all in the data.
 * Delivery prices a checkout; this records what goes on an invoice and on the business-identity
 * page. Putting them together would mean a later track touching VAT has to read the zone matcher to
 * find out whether it may.
 */

export {
  VAT_BASIS_POINTS_MAX,
  VAT_BASIS_POINTS_MIN_NONZERO,
  getTaxSettings,
  saveTaxSettings,
  taxSettingsSchema,
  vatPercentLabel,
  type TaxSettingsInput,
  type TaxSettingsView,
} from './settings';
