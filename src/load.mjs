// Stage 5: write the intermediate model into Vendure through the Admin API.
// Every create is bound (source -> target id) before moving on; anything already bound is
// skipped, so a re-run after a failure continues instead of duplicating. The steps live in
// src/load/, one function each.
import path from 'node:path';
import { openBindings } from './lib/bindings.mjs';
import { log, readJson, writeJson } from './lib/util.mjs';
import { VendureClient } from './lib/vendure-client.mjs';
import { createContext } from './load/context.mjs';
import { STEPS } from './load/steps.mjs';

/**
 * Creates the model of one snapshot in Vendure.
 *
 * Side effects: creates Vendure objects; appends every binding to
 * `<snapshot>/load-journal.ndjson`; writes `<outDir>/bindings.json` and `<snapshot>/load-result.json`.
 *
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @param {string} snapshotDir Snapshot folder holding model.json.
 * @param {{ client?: VendureClient, fetch?: typeof fetch }} [deps] Replacements for tests: a
 *   client with the VendureClient interface, and the fetch used for image downloads.
 * @returns {Promise<{ startedAt: string, finishedAt: string, counts: object, timings: object,
 *   failures: Array<{ step: string, sourceId: string, message: string, graphql?: string[] }>,
 *   bindings: number }>} Items that failed are listed in `failures`, stay unbound, and are
 *   retried by the next run.
 * @throws {Error} When model.json cannot be read, bindings.json belongs to another Vendure, the
 *   login fails, or the settings or channel step fails. load-result.json is still written for a
 *   failed step, with the error in `aborted`.
 */
export async function load(config, snapshotDir, deps = {}) {
    const startedAt = new Date().toISOString();
    const model = await readJson(path.join(snapshotDir, 'model.json'));
    // Opened before the login, so a table for another Vendure is refused without any request.
    const bindings = await openBindings(config, snapshotDir);
    const http = { ...config.http, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
    const client = deps.client ?? new VendureClient(config.target, http);
    await client.login();
    const ctx = createContext({ model, client, bindings, http });

    let aborted;
    for (const [name, run, fatal] of STEPS) {
        try {
            await runStep(ctx, name, run);
        } catch (e) {
            // The other steps record failures per item; an error that still escapes one is
            // recorded the same way and the next step runs.
            ctx.fail(name, '-', e);
            if (fatal) {
                aborted = `${name}: ${e.message}`;
                break;
            }
        }
    }

    const result = {
        startedAt,
        finishedAt: new Date().toISOString(),
        counts: ctx.counts,
        timings: ctx.timings,
        failures: ctx.failures,
        bindings: bindings.size,
        ...(aborted ? { aborted } : {}),
    };
    await writeJson(path.join(snapshotDir, 'load-result.json'), result);
    log(`load done: ${ctx.failures.length} failures, ${bindings.size} bindings`);
    if (aborted) throw new Error(`load stopped at ${aborted}`);
    return result;
}

async function runStep(ctx, name, run) {
    const t0 = Date.now();
    const c = { created: 0, skipped: 0 };
    ctx.counts[name] = c;
    try {
        await run(ctx, c);
    } finally {
        await ctx.bindings.flush();
        ctx.timings[name] = Date.now() - t0;
        const extra = Object.entries(c).filter(([k]) => k !== 'created' && k !== 'skipped').map(([k, v]) => `, ${k} ${v}`).join('');
        log(`load ${name}: created ${c.created}, skipped ${c.skipped}${extra} (${ctx.timings[name]} ms)`);
    }
}
