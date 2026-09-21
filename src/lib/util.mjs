import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeJson(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const text = JSON.stringify(data, null, 2);
    await fs.writeFile(file, text, 'utf8');
    return sha256(text);
}

export async function readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

/** Lowercase ASCII slug. Vendure normalises slugs itself; this keeps codes readable and stable. */
export function slugify(input) {
    return String(input ?? '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/ß/g, 'ss')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** Returns a function that hands out unique codes within one namespace. */
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
 * Converts a decimal amount to minor units. Refuses values with sub-cent precision
 * instead of rounding them silently, so the caller can report them.
 */
export function toMinorUnits(amount, decimals = 2) {
    const value = Number(amount);
    if (!Number.isFinite(value)) return { ok: false, reason: 'not a number', value: amount };
    const scaled = value * 10 ** decimals;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6) return { ok: false, reason: 'sub-minor-unit precision', value: amount };
    return { ok: true, minor: rounded };
}

export function groupBy(rows, key) {
    const map = new Map();
    for (const row of rows) {
        const k = typeof key === 'function' ? key(row) : row[key];
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(row);
    }
    return map;
}

export function log(...args) {
    console.log(new Date().toISOString().slice(11, 19), ...args);
}
