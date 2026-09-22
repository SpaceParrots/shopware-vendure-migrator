// Shared state of one load run and the rules every step follows when it refers to an object an
// earlier step created.
//
// A reference to another Vendure object always goes through need(). Before, a missing binding
// became `undefined`, which `.filter(Boolean)` or JSON.stringify quietly dropped: the dependent
// object was created without it, bound, and skipped by every later run, so nothing ever repaired
// it. Now the dependent object is not created, a failure is recorded, and the next run retries.
import { log } from '../lib/util.mjs';

export class MissingDependencyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MissingDependencyError';
    }
}

/**
 * @template T
 * @param {T} value Result of a binding lookup.
 * @param {string} what Names the dependency in the error.
 * @returns {T} value, when it is set.
 * @throws {MissingDependencyError} When value is undefined, null or ''.
 */
export function need(value, what) {
    if (value === undefined || value === null || value === '') {
        throw new MissingDependencyError(`${what} is not in Vendure yet (its create failed or has not run); not creating the dependent object, the next run retries it`);
    }
    return value;
}

/** The price load sends as the variant price: gross when the channel's prices include tax, else net. */
export function channelPrice(model, offer) {
    return model.pricesIncludeTax ? offer.priceGrossMinor : offer.priceNetMinor;
}

/**
 * Why load refuses to create an offer, or undefined when it can. Vendure 3.7.3 turns a null price
 * into 0 and a missing taxCategoryId into the default tax category, so either would create a
 * variant that looks valid and sells at the wrong price or tax.
 */
export function offerProblem(model, offer) {
    const price = channelPrice(model, offer);
    if (!Number.isInteger(price)) {
        return `no ${model.pricesIncludeTax ? 'gross' : 'net'} price in the model (${JSON.stringify(price ?? null)}); Vendure would store 0`;
    }
    if (offer.taxSourceId == null) return 'no tax category after inheritance; Vendure would assign its default tax category';
    return undefined;
}

/** Runs worker over items with at most `size` calls in flight. */
export async function pool(items, size, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            await worker(items[i], i);
        }
    });
    await Promise.all(runners);
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Pairs requested items with objects Vendure returned, by code: exact code first, then the code
 * with a numeric suffix Vendure may add to keep codes unique (`red` -> `red-2`) when exactly one
 * such object is left, then, when exactly one item and one object remain, those two.
 * @param {Array<{ code: string }>} wanted
 * @param {Array<{ id: string|number, code: string }>} returned
 * @returns {{ pairs: Array<[object, string]>, unmatched: object[], unclaimed: object[] }}
 *   `unmatched` are wanted items without a partner, `unclaimed` returned objects without one.
 */
export function matchByCode(wanted, returned) {
    const left = [...returned];
    const pairs = [];
    const take = (item, index) => {
        pairs.push([item, String(left[index].id)]);
        left.splice(index, 1);
    };
    let unmatched = [];
    for (const item of wanted) {
        const i = left.findIndex(r => r.code === item.code);
        if (i >= 0) take(item, i);
        else unmatched.push(item);
    }
    unmatched = unmatched.filter(item => {
        const suffixed = new RegExp(`^${escapeRegExp(item.code)}-\\d+$`);
        const hits = left.map((r, i) => (suffixed.test(r.code) ? i : -1)).filter(i => i >= 0);
        if (hits.length !== 1) return true;
        take(item, hits[0]);
        return false;
    });
    if (unmatched.length === 1 && left.length === 1) {
        take(unmatched[0], 0);
        unmatched = [];
    }
    return { pairs, unmatched, unclaimed: left };
}

/**
 * Binds child objects (facet values, product options) of a parent that is already bound.
 * @param {Array<{ code: string, bind: (id: string) => Promise<void> }>} wanted Unbound model items.
 * @param {Array<{ id: string|number, code: string }>} existing Children in Vendure that no model
 *   item is bound to yet.
 * @param {(items: object[]) => Promise<Array<{ id: string|number, code: string }>>} create
 *   Creates the items for which Vendure has no child at all.
 * @param {string} what Names the parent in errors.
 * @returns {Promise<void>}
 * @throws {Error} When leftover items and leftover children cannot be paired safely; creating
 *   more children then would duplicate them.
 */
export async function bindChildren(wanted, existing, create, what) {
    const first = matchByCode(wanted, existing);
    for (const [item, id] of first.pairs) await item.bind(id);
    if (!first.unmatched.length) return;
    if (first.unclaimed.length) {
        throw new Error(`${what}: cannot tell which of the Vendure codes ${first.unclaimed.map(x => x.code).join(', ')} belong to ${first.unmatched.map(x => x.code).join(', ')}`);
    }
    const second = matchByCode(first.unmatched, await create(first.unmatched));
    for (const [item, id] of second.pairs) await item.bind(id);
    if (second.unmatched.length) throw new Error(`${what}: Vendure returned no id for ${second.unmatched.map(x => x.code).join(', ')}`);
}

/**
 * State and lookups shared by the load steps.
 * @param {{ model: object, client: object, bindings: import('../lib/bindings.mjs').Bindings,
 *   http: object }} deps `http` holds the request() options for downloads.
 */
export function createContext({ model, client, bindings, http }) {
    const lang = model.defaultLanguageCode;
    const failures = [];
    // Private media are not uploaded, so a reference to one is left out rather than awaited.
    const uploadable = new Set(model.assets.filter(a => !a.private).map(a => a.sourceId));
    const countriesByCode = new Map(model.countries.map(c => [c.code, c]));
    const offersById = new Map(model.families.flatMap(f => f.offers).map(o => [o.sourceId, o]));

    const ref = {
        country: code => need(
            bindings.get('country', need(countriesByCode.get(code), `country ${code} of the model`).sourceId, 'country'),
            `country ${code}`,
        ),
        zone: key => need(bindings.get('zone', key, 'zone'), `zone ${key}`),
        taxCategory: sourceId => need(bindings.get('tax', sourceId, 'taxCategory'), `tax category ${sourceId}`),
        assets: mediaIds => mediaIds.filter(id => uploadable.has(id)).map(id => need(bindings.get('media', id, 'asset'), `asset ${id}`)),
        featuredAsset: mediaId => (mediaId && uploadable.has(mediaId) ? need(bindings.get('media', mediaId, 'asset'), `asset ${mediaId}`) : undefined),
        propertyValue: optionId => need(bindings.get('propertyOption', optionId, 'facetValue'), `facet value of property option ${optionId}`),
        manufacturerValue: id => need(bindings.get('manufacturer', id, 'facetValue'), `facet value of manufacturer ${id}`),
        option: (familyId, optionId) => need(bindings.get('productOption', `${familyId}|${optionId}`, 'option'), `product option ${optionId} of product ${familyId}`),
        variant: offerId => need(bindings.get('product', offerId, 'variant'), `variant ${offersById.get(offerId)?.sku ?? offerId}`),
        collection: categoryId => need(bindings.get('category', categoryId, 'collection'), `collection ${categoryId}`),
    };

    return {
        model,
        client,
        bindings,
        http,
        lang,
        failures,
        counts: {},
        timings: {},
        ref,
        /** Offers load creates; the others are recorded as failures in the products step. */
        isCreatable: offerId => offersById.has(offerId) && !offerProblem(model, offersById.get(offerId)),
        fail(step, sourceId, err) {
            failures.push({ step, sourceId, message: err.message, graphql: err.graphqlErrors?.map(e => e.message) });
            log(`FAIL ${step} ${sourceId}: ${err.message}`);
        },
        /** Translation list with the default language guaranteed, as Vendure requires. */
        translations(byLang, extra = () => ({})) {
            const codes = Object.keys(byLang);
            const list = codes.map(code => ({ languageCode: code, name: byLang[code], ...extra(code) }));
            if (!codes.includes(lang)) {
                const fallback = codes[0];
                list.push({ languageCode: lang, name: fallback ? byLang[fallback] : '(unnamed)', ...extra(fallback ?? lang) });
            }
            return list;
        },
    };
}
