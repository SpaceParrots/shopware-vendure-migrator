// Storefront sales channel, countries, tax categories and tax zones.
import { groupTaxZones } from '../lib/resolve.mjs';
import { groupBy } from '../lib/util.mjs';

/**
 * Picks the storefront sales channel whose catalogue is migrated.
 * @param {Array<{ type_id: string }>} salesChannels Rows of raw/sales_channels.json.
 * @param {string} storefrontTypeId Shopware's Defaults::SALES_CHANNEL_TYPE_STOREFRONT.
 * @returns {object} The sales channel row.
 * @throws {Error} When there is no storefront sales channel.
 */
export function pickStorefront(salesChannels, storefrontTypeId) {
    const storefront = salesChannels.find(sc => sc.type_id === storefrontTypeId);
    if (!storefront) throw new Error('No storefront sales channel found.');
    return storefront;
}

/**
 * Countries with their names, enabled when active and assigned to the storefront.
 * @param {object} raw Snapshot tables (countries, country_translations, sales_channel_countries).
 * @param {{ storefront: { id: string }, namesOf: Function }} ctx
 * @returns {Array<{ sourceId: string, code: string, names: Record<string, string>, enabled: boolean }>} Never throws.
 */
export function buildCountries(raw, { storefront, namesOf }) {
    const storefrontCountryIds = new Set(
        raw.sales_channel_countries.filter(r => r.sales_channel_id === storefront.id).map(r => r.country_id),
    );
    const countryNames = groupBy(raw.country_translations, 'country_id');
    return raw.countries.map(c => ({
        sourceId: c.id,
        code: c.iso,
        names: namesOf(countryNames.get(c.id)),
        enabled: Boolean(c.active) && storefrontCountryIds.has(c.id),
    }));
}

/**
 * Tax categories (by Shopware position) and the tax zones Vendure needs for them.
 * @param {object} raw Snapshot tables (taxes, tax_rules).
 * @param {Array<{ sourceId: string, code: string }>} countries Output of buildCountries.
 * @returns {{
 *   taxCategories: Array<{ sourceId: string, name: string, defaultRate: number, isDefault: boolean }>,
 *   taxZones: object[],
 *   gaps: { taxRulesNotCountryWide?: number },
 *   decisions: Array<{ topic: string, text: string }>,
 * }} Never throws.
 */
export function buildTax(raw, countries) {
    const taxCategories = raw.taxes
        .toSorted((a, b) => a.position - b.position)
        .map((t, i) => ({ sourceId: t.id, name: t.name, defaultRate: Number(t.tax_rate), isDefault: i === 0 }));
    const nonCountryRules = raw.tax_rules.filter(r => r.type !== 'entire_country');
    const { taxZones, defaultTuple } = groupTaxZones(countries, taxCategories, raw.tax_rules);
    return {
        taxCategories,
        taxZones,
        gaps: nonCountryRules.length ? { taxRulesNotCountryWide: nonCountryRules.length } : {},
        decisions: [
            {
                topic: 'tax',
                text: `Shopware applies a tax's default rate everywhere except countries with a tax_rule. Vendure rates belong to zones, so countries are grouped by their rate tuple (${taxCategories.map(t => t.name).join(' / ')}) into ${taxZones.length} tax zones. The zone matching the default rates (${defaultTuple}) is the channel's default tax zone.`,
            },
        ],
    };
}
