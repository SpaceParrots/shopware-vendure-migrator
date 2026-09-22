import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes `data` as pretty-printed JSON, creating the directory if needed.
 * @param {string} file Target path.
 * @param {unknown} data Any JSON-serialisable value.
 * @returns {Promise<string>} sha256 (hex) of the exact text written.
 * @throws {Error} When the directory cannot be created or the file cannot be written.
 */
export async function writeJson(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const text = JSON.stringify(data, null, 2);
    await fs.writeFile(file, text, 'utf8');
    return sha256(text);
}

/**
 * Reads and parses a JSON file.
 * @param {string} file Source path.
 * @returns {Promise<any>} The parsed value.
 * @throws {Error} When the file cannot be read; {SyntaxError} when it is not valid JSON.
 */
export async function readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

/**
 * @param {string} text
 * @returns {string} sha256 of the UTF-8 text, hex encoded. Never throws.
 */
export function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

/**
 * Lowercase ASCII slug. Vendure normalises slugs itself; this keeps codes readable and stable.
 * @param {unknown} input Anything; null and undefined give ''.
 * @returns {string} The slug, possibly empty. Never throws.
 */
export function slugify(input) {
    return String(input ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/ß/g, 'ss')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Returns a function that hands out unique codes within one namespace: the first caller gets
 * `base`, later callers `base-2`, `base-3`, and so on. An empty base becomes `item`.
 * @returns {(base: string) => string} Never throws.
 */
export function uniqueCoder() {
    const seen = new Set();
    return base => {
        const root = base || 'item';
        let code = root;
        for (let i = 2; seen.has(code); i++) code = `${root}-${i}`;
        seen.add(code);
        return code;
    };
}

/**
 * Converts a decimal amount to minor units. Refuses missing values, non-numbers and values with
 * more precision than the currency has, instead of guessing or rounding, so the caller can
 * report them.
 * @param {unknown} amount A number or a decimal string.
 * @param {number} [decimals=2] Minor-unit digits of the currency.
 * @returns {{ ok: true, minor: number } | { ok: false, reason: string, value: unknown }}
 *   reason is 'missing' (null, undefined, blank string), 'not a string or number',
 *   'not a number' or 'sub-minor-unit precision'.
 * @throws {RangeError} When `decimals` is not a non-negative integer (a programming error).
 */
export function toMinorUnits(amount, decimals = 2) {
    if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError(`decimals must be a non-negative integer, got ${decimals}`);
    if (amount === null || amount === undefined || (typeof amount === 'string' && amount.trim() === '')) {
        return { ok: false, reason: 'missing', value: amount };
    }
    if (typeof amount !== 'string' && typeof amount !== 'number') return { ok: false, reason: 'not a string or number', value: amount };
    const value = Number(amount);
    if (!Number.isFinite(value)) return { ok: false, reason: 'not a number', value: amount };
    const scaled = value * 10 ** decimals;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6) return { ok: false, reason: 'sub-minor-unit precision', value: amount };
    return { ok: true, minor: rounded };
}

/**
 * Groups rows by a column or a key function, keeping the input order inside each group.
 * @template T
 * @param {T[]} rows
 * @param {string | ((row: T) => unknown)} key
 * @returns {Map<unknown, T[]>} A new map; the input is not modified. Never throws.
 */
export function groupBy(rows, key) {
    const map = new Map();
    for (const row of rows) {
        const k = typeof key === 'function' ? key(row) : row[key];
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(row);
    }
    return map;
}

/**
 * Renders records as RFC 4180 CSV: CRLF line breaks, a field is quoted when it contains a comma,
 * a double quote, CR or LF, and quotes inside it are doubled. null and undefined become empty.
 * @param {string[]} header Column names.
 * @param {unknown[][]} rows One array of field values per record.
 * @returns {string} The CSV text, every line ending in CRLF. Never throws.
 */
export function toCsv(header, rows) {
    const field = value => {
        const text = value === null || value === undefined ? '' : String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [header, ...rows].map(r => r.map(field).join(',')).join('\r\n') + '\r\n';
}

/**
 * Prints a line to stdout, prefixed with the UTC time of day.
 * @param {...unknown} args Passed to console.log.
 * @returns {void} Never throws.
 */
export function log(...args) {
    console.log(new Date().toISOString().slice(11, 19), ...args);
}

/**
 * Prints a line to stderr in the same format as `log`, so errors stay on the terminal when
 * stdout is redirected.
 * @param {...unknown} args Passed to console.error.
 * @returns {void} Never throws.
 */
export function logError(...args) {
    console.error(new Date().toISOString().slice(11, 19), ...args);
}
