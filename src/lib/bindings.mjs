// Source-to-target bindings. The key carries a target role because one Shopware row can
// produce several Vendure objects (a simple product becomes a Product and a ProductVariant).
//
// Bindings are flushed in batches; every create is also appended to the run journal first.
// load() replays the journal on top of bindings.json and flushes, so a crash between two
// flushes loses nothing and the next run skips those objects instead of duplicating them.
// To start over against an empty Vendure, delete bindings.json and the load journals together.
//
// bindings.json records the Admin API URL it was written for. Ids from one Vendure mean nothing
// in another, so opening the table for a different URL is refused instead of skipping creates.
import fs from 'node:fs/promises';
import path from 'node:path';

const FLUSH_EVERY = 100;
export const BINDINGS_FILE = 'bindings.json';
export const JOURNAL_FILE = 'load-journal.ndjson';

/** Ids a failed lookup produces; binding one would make every later run skip a missing object. */
function isEmptyId(id) {
    return id === undefined || id === null || id === '' || id === 'undefined' || id === 'null';
}

const sameTarget = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * Journal files of every snapshot, oldest first, with the current snapshot's last. `all` starts
 * a new snapshot per run, so bindings a crashed run did not flush sit in an older snapshot.
 * Snapshot names are timestamps, so name order is creation order.
 * @param {string} outDir Folder holding `snapshots/`.
 * @param {string} snapshotDir The current snapshot; its journal is always last, even when the
 *   folder does not exist yet.
 * @returns {Promise<string[]>} Paths of journal files; some may not exist.
 */
export async function snapshotJournals(outDir, snapshotDir) {
    const dir = path.join(outDir, 'snapshots');
    const others = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort()
        .map(name => path.join(dir, name))
        .filter(d => path.resolve(d) !== path.resolve(snapshotDir));
    return [...others, snapshotDir].map(d => path.join(d, JOURNAL_FILE));
}

/**
 * Opens the shared binding table of `config.outDir` with every snapshot's journal replayed.
 * @param {{ outDir: string, target: { adminApi: string } }} config
 * @param {string} snapshotDir Snapshot whose journal receives new bindings.
 * @param {{ readOnly?: boolean }} [options] Read-only opens write nothing: no flush, no journal,
 *   no repair of a torn journal line. verify and oracle open it this way.
 * @returns {Promise<Bindings>}
 * @throws {Error} See Bindings#load.
 */
export async function openBindings(config, snapshotDir, { readOnly = false } = {}) {
    return new Bindings(
        path.join(config.outDir, BINDINGS_FILE),
        path.join(snapshotDir, JOURNAL_FILE),
        await snapshotJournals(config.outDir, snapshotDir),
        { target: config.target.adminApi, readOnly },
    ).load();
}

export class Bindings {
    /**
     * @param {string} file Path of bindings.json.
     * @param {string} journalFile Journal that set() appends to.
     * @param {string[]} [replayFiles=[journalFile]] Journals load() replays, oldest first.
     * @param {{ target?: string, readOnly?: boolean }} [options] `target` is the Vendure Admin API
     *   URL; when given, load() refuses a table or journal written for another URL.
     */
    constructor(file, journalFile, replayFiles = [journalFile], { target, readOnly = false } = {}) {
        this.file = file;
        this.journalFile = journalFile;
        this.replayFiles = replayFiles;
        this.target = target;
        this.readOnly = readOnly;
        this.map = new Map();
        this.dirty = 0;
        // Flushes and journal appends each run one at a time, in call order: two overlapping
        // flushes would share one tmp file, and interleaved appends could tear journal lines.
        this.flushing = Promise.resolve();
        this.appending = Promise.resolve();
    }

    static key(entity, sourceId, role) {
        return `shopware|${entity}|${sourceId}|${role}`;
    }

    /**
     * Reads bindings.json, replays the journals over it and, unless read-only, saves the result.
     * @returns {Promise<this>}
     * @throws {Error} When bindings.json or a journal was written for another target URL, holds
     *   an empty target id, or has an unparseable line that is not the last one of its journal.
     */
    async load() {
        let rows = {};
        try {
            const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
            // Files written before the target was recorded are a flat key -> id object.
            const legacy = !parsed.bindings || typeof parsed.bindings !== 'object';
            rows = legacy ? parsed : parsed.bindings;
            if (!legacy && parsed.target) this.checkTarget(parsed.target, this.file);
            if (!legacy && parsed.target && !this.target) this.target = parsed.target;
            // Adopting the current target is written back on the first flush.
            if (legacy || !parsed.target) this.dirty++;
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
        for (const [k, v] of Object.entries(rows)) {
            if (typeof v !== 'string' || isEmptyId(v)) throw new Error(emptyIdMessage(this.file, k, v));
            this.map.set(k, v);
        }
        // Oldest journal first, so the newest create wins when a key was bound twice.
        for (const journal of this.replayFiles) await this.replay(journal);
        if (this.readOnly) return this;
        await this.flush();
        await fs.mkdir(path.dirname(this.journalFile), { recursive: true });
        return this;
    }

    checkTarget(recorded, where) {
        if (this.target && !sameTarget(recorded, this.target)) {
            throw new Error(
                `${where} was written for the Vendure Admin API at ${recorded}, but this run targets ${this.target}. `
                + 'Its ids mean nothing in another Vendure. Use a separate MIGRATOR_OUT_DIR per target, '
                + 'or set VENDURE_ADMIN_API back to the recorded URL.',
            );
        }
    }

    async replay(journal) {
        let text;
        try {
            text = await fs.readFile(journal, 'utf8');
        } catch (e) {
            if (e.code === 'ENOENT') return;
            throw e;
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            let entry;
            try {
                entry = JSON.parse(lines[i]);
            } catch (e) {
                if (i < lines.length - 1) throw new Error(`${journal} line ${i + 1} is not valid JSON: ${e.message}`);
                // A crash in the middle of appendFile leaves a torn last line; that create
                // never got its binding, so dropping it matches the crash. Cut it off the file
                // too, or the next append would glue onto it and break a line mid-journal.
                if (!this.readOnly) await fs.truncate(journal, Buffer.byteLength(text) - Buffer.byteLength(lines[i]));
                continue;
            }
            if (typeof entry.key !== 'string' || typeof entry.targetId !== 'string') {
                throw new Error(`${journal} line ${i + 1} has no string key and targetId`);
            }
            if (isEmptyId(entry.targetId)) throw new Error(emptyIdMessage(`${journal} line ${i + 1}`, entry.key, entry.targetId));
            if (entry.target) this.checkTarget(entry.target, `${journal} line ${i + 1}`);
            if (this.map.get(entry.key) === entry.targetId) continue;
            this.map.set(entry.key, entry.targetId);
            this.dirty++;
        }
    }

    /** @returns {string|undefined} The bound Vendure id, or undefined when nothing is bound. */
    get(entity, sourceId, role) {
        return this.map.get(Bindings.key(entity, sourceId, role));
    }

    /**
     * Binds a source row to a Vendure id: appends to the journal, then updates the table, and
     * flushes every FLUSH_EVERY bindings.
     * @param {string} entity
     * @param {string} sourceId
     * @param {string} role
     * @param {string|number} targetId Id Vendure returned.
     * @returns {Promise<void>}
     * @throws {Error} When targetId is empty (null, undefined, '', 'undefined', 'null') or the
     *   table was opened read-only. Nothing is written in that case.
     */
    async set(entity, sourceId, role, targetId) {
        const key = Bindings.key(entity, sourceId, role);
        if (this.readOnly) throw new Error(`Bindings opened read-only; cannot bind ${key}`);
        if (isEmptyId(targetId)) {
            throw new Error(`Refusing to bind ${key} to the empty id ${JSON.stringify(targetId)}; the object stays unbound so the next run looks at it again`);
        }
        const line = `${JSON.stringify({ t: new Date().toISOString(), key, targetId: String(targetId), target: this.target })}\n`;
        const append = this.appending.then(() => fs.appendFile(this.journalFile, line));
        this.appending = append.catch(() => {});
        await append;
        this.map.set(key, String(targetId));
        if (++this.dirty >= FLUSH_EVERY) await this.flush();
    }

    /**
     * Writes the table to bindings.json (tmp file, then rename). Calls are serialized; each one
     * writes the state at the moment it starts and clears only the changes it wrote, so a set()
     * that lands during a write is saved by the next flush.
     * @returns {Promise<void>}
     */
    flush() {
        if (this.readOnly) return Promise.resolve();
        const run = this.flushing.then(() => this.write());
        this.flushing = run.catch(() => {});
        return run;
    }

    async write() {
        const count = this.dirty;
        if (!count) return;
        await this.persist(JSON.stringify({ target: this.target ?? null, bindings: Object.fromEntries(this.map) }, null, 1));
        this.dirty -= count;
    }

    async persist(text) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, text, 'utf8');
        await fs.rename(tmp, this.file);
    }

    get size() {
        return this.map.size;
    }
}

function emptyIdMessage(where, key, id) {
    return `${where} binds ${key} to the empty id ${JSON.stringify(id)}. An earlier run could not read the id Vendure returned. `
        + 'Remove that entry, check Vendure for the object, and delete it there before the next load creates it again.';
}
