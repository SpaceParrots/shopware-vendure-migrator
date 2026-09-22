// Shopware price JSON -> the gross and net price of an offer in minor units.
import { toMinorUnits } from '../lib/util.mjs';

const DEFAULT_DECIMALS = 2;

/**
 * Minor-unit digits of a currency, from `currency.item_rounding.decimals`.
 * @param {{ item_rounding?: unknown }} currency Row of raw/currencies.json. item_rounding is the
 *   parsed JSON column or its text.
 * @returns {{ decimals: number, source: 'item_rounding'|'default' }} 2 when the value is absent or
 *   not a non-negative integer. Never throws.
 */
export function currencyDecimals(currency) {
    let rounding = currency?.item_rounding;
    if (typeof rounding === 'string') {
        try {
            rounding = JSON.parse(rounding);
        } catch {
            rounding = null;
        }
    }
    const raw = rounding?.decimals;
    const decimals = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isInteger(decimals) && decimals >= 0 ? { decimals, source: 'item_rounding' } : { decimals: DEFAULT_DECIMALS, source: 'default' };
}

/**
 * Gross and net price of one offer from Shopware's price JSON (already inherited from the parent
 * when the variant has none). Both come from the default-currency entry `c<currencyId>`.
 * @param {unknown} priceValue The price column: JSON text, a parsed object, or null.
 * @param {{ currencyId: string, decimals: number, pricesIncludeTax: boolean }} options
 *   pricesIncludeTax picks the price load sends (gross when true, net when false); only a missing
 *   chosen price is a problem.
 * @returns {{
 *   priceGrossMinor: number|null,
 *   priceNetMinor: number|null,
 *   problem: null | { kind: 'unpriced'|'invalidPriceJson'|'nonDefaultCurrencyOnly'|'subCentPrice'|'unconvertiblePrice', field?: string, value?: unknown, reason: string },
 *   hasListPrice: boolean,
 *   otherCurrencyKeys: string[],
 * }} null prices mean missing or not convertible. Never throws.
 */
export function resolvePrice(priceValue, { currencyId, decimals, pricesIncludeTax }) {
    const none = { priceGrossMinor: null, priceNetMinor: null, hasListPrice: false, otherCurrencyKeys: [] };
    let json = priceValue;
    if (typeof priceValue === 'string') {
        try {
            json = JSON.parse(priceValue);
        } catch {
            return { ...none, problem: { kind: 'invalidPriceJson', reason: 'price column is not valid JSON' } };
        }
    }
    if (!json || typeof json !== 'object') return { ...none, problem: { kind: 'unpriced', reason: 'no price' } };

    const key = `c${currencyId}`;
    const entries = Object.entries(json);
    const hasListPrice = entries.some(([, p]) => p?.listPrice !== null && p?.listPrice !== undefined);
    const otherCurrencyKeys = entries.map(([k]) => k).filter(k => k !== key);
    const entry = json[key];
    if (!entry) return { ...none, hasListPrice, otherCurrencyKeys, problem: { kind: 'nonDefaultCurrencyOnly', reason: 'no price in the default currency' } };

    const gross = toMinorUnits(entry.gross, decimals);
    const net = toMinorUnits(entry.net, decimals);
    const [field, chosen] = pricesIncludeTax ? ['gross', gross] : ['net', net];
    return {
        priceGrossMinor: gross.ok ? gross.minor : null,
        priceNetMinor: net.ok ? net.minor : null,
        hasListPrice,
        otherCurrencyKeys,
        problem: chosen.ok
            ? null
            : { kind: chosen.reason === 'sub-minor-unit precision' ? 'subCentPrice' : 'unconvertiblePrice', field, value: entry[field] ?? null, reason: `${field} price ${chosen.reason}` },
    };
}
