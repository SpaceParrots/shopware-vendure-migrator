// Property groups and manufacturers -> Vendure facets.
import { groupBy, slugify, uniqueCoder } from '../lib/util.mjs';

/**
 * One facet per property group (its options as values) plus one "manufacturer" facet whose values
 * are the manufacturers some product uses.
 * @param {object} raw Snapshot tables (property_groups, property_group_translations,
 *   property_group_options, property_group_option_translations, manufacturers,
 *   manufacturer_translations, products).
 * @param {{ defaultLanguageCode: string, namesOf: Function }} ctx
 * @returns {{ facets: object[], decisions: Array<{ topic: string, text: string }> }} Never throws.
 */
export function buildFacets(raw, { defaultLanguageCode, namesOf }) {
    const groupNames = groupBy(raw.property_group_translations, 'group_id');
    const optionNames = groupBy(raw.property_group_option_translations, 'option_id');
    const manufacturerNames = groupBy(raw.manufacturer_translations, 'manufacturer_id');
    const optionsOf = groupBy(raw.property_group_options, 'group_id');
    const facetCodes = uniqueCoder();

    const propertyFacets = raw.property_groups.map(g => {
        const names = namesOf(groupNames.get(g.id));
        const valueCodes = uniqueCoder();
        return {
            sourceId: g.id,
            kind: 'property',
            code: facetCodes(`prop-${slugify(names[defaultLanguageCode] ?? g.id)}`),
            names,
            values: (optionsOf.get(g.id) ?? []).map(o => {
                const on = namesOf(optionNames.get(o.id));
                return { sourceId: o.id, code: valueCodes(slugify(on[defaultLanguageCode] ?? o.id)), names: on };
            }),
        };
    });

    const usedManufacturers = new Set(raw.products.map(p => p.manufacturer_id).filter(Boolean));
    const manufacturerValueCodes = uniqueCoder();
    const manufacturerFacet = {
        sourceId: 'manufacturer',
        kind: 'manufacturer',
        code: facetCodes('manufacturer'),
        names: { en: 'Manufacturer', de: 'Hersteller' },
        values: raw.manufacturers
            .filter(m => usedManufacturers.has(m.id))
            .map(m => {
                const mn = namesOf(manufacturerNames.get(m.id));
                return { sourceId: m.id, code: manufacturerValueCodes(slugify(mn[defaultLanguageCode] ?? m.id)), names: mn };
            }),
    };

    return {
        facets: [...propertyFacets, manufacturerFacet],
        decisions: [
            { topic: 'facets', text: 'Every Shopware property group becomes a Vendure Facet with its options as FacetValues; manufacturers become values of one "manufacturer" facet. Variant-defining options become ProductOptions separately; a group used both ways exists in both forms.' },
            { topic: 'variant facets', text: 'Product-level facet values come from the parent; a variant with its own product_property rows also gets those as variant facet values. Shopware replaces the parent set in that case, Vendure unions product and variant values: a documented deviation.' },
        ],
    };
}
