// Storefront sales channel, countries, tax categories and tax zones.
import { effectiveTaxRules, groupTaxZones } from '../lib/resolve.mjs';
import { groupBy } from '../lib/util.mjs';

/**
 * Picks the storefront sales channel whose catalogue is migrated: the first active storefront in
 * id order (extract sorts active channels first, then by id; this does not rely on that).
 * @param {Array<{ id: string, type_id: string, active: unknown }>} salesChannels Rows of raw/sales_channels.json.
 * @param {string} storefrontTypeId Shopware's Defaults::SALES_CHANNEL_TYPE_STOREFRONT.
 * @returns {object} The sales channel row.
 * @throws {Error} When there is no active storefront sales channel.
 */
export function pickStorefront(salesChannels, storefrontTypeId) {
    const storefronts = salesChannels.filter(sc => sc.type_id === storefrontTypeId);
    const active = storefronts.filter(sc => Number(sc.active) === 1).toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (!active.length) {
        throw new Error(`No active storefront sales channel found (${storefronts.length} storefront channels, all inactive). Activate one in Shopware or check the source database.`);
    }
    return active[0];
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
 * @param {object} raw Snapshot tables (taxes, tax_rules, source_identity).
 * @param {Array<{ sourceId: string, code: string }>} countries Output of buildCountries.
 * @returns {{
 *   taxCategories: Array<{ sourceId: string, name: string, defaultRate: number, isDefault: boolean }>,
 *   taxZones: object[],
 *   gaps: { taxRulesNotCountryWide?: number, taxRules: object },
 *   decisions: Array<{ topic: string, text: string }>,
 * }}
 * @throws {Error} When the snapshot has no readable extract time (source_identity.utc_now).
 */
export function buildTax(raw, countries) {
    const taxCategories = raw.taxes
        .toSorted((a, b) => a.position - b.position)
        .map((t, i) => ({ sourceId: t.id, name: t.name, defaultRate: Number(t.tax_rate), isDefault: i === 0 }));
    const asOf = raw.source_identity?.[0]?.utc_now;
    const effective = effectiveTaxRules(raw.tax_rules, asOf);
    const nonCountryRules = effective.rules.filter(r => r.type !== 'entire_country');
    const { taxZones, defaultTuple } = groupTaxZones(countries, taxCategories, effective.rules);
    const isoOf = new Map(countries.map(c => [c.sourceId, c.code]));
    const taxName = new Map(taxCategories.map(t => [t.sourceId, t.name]));
    const describe = r => ({ id: r.id, type: r.type, country: isoOf.get(r.country_id) ?? r.country_id, tax: taxName.get(r.tax_id) ?? r.tax_id, rate: Number(r.tax_rate), activeFrom: r.active_from });
    return {
        taxCategories,
        taxZones,
        gaps: {
            ...(nonCountryRules.length ? { taxRulesNotCountryWide: nonCountryRules.length } : {}),
            taxRules: {
                asOf,
                futureRules: effective.future.map(describe),
                duplicateRules: effective.duplicates.map(d => ({ ...d, country: isoOf.get(d.country_id) ?? d.country_id, tax: taxName.get(d.tax_id) ?? d.tax_id })),
                unreadableActiveFrom: effective.invalid.map(describe),
                verdict: 'rates are the tax rules in force at extract time (newest active_from not after it); rules that start later are not migrated and need a manual rate change in Vendure on their date',
            },
        },
        decisions: [
            {
                topic: 'tax',
                text: `Shopware applies a tax's default rate everywhere except countries with a tax_rule. Vendure rates belong to zones, so countries are grouped by their rate tuple (${taxCategories.map(t => t.name).join(' / ')}) into ${taxZones.length} tax zones. The zone matching the default rates (${defaultTuple}) is the channel's default tax zone. Of several rules for one country and tax, the one in force at extract time (${asOf} UTC) is used: the newest active_from that is not later.`,
            },
        ],
    };
}
