// Source-to-target bindings. The key carries a target role because one Shopware row can
// produce several Vendure objects (a simple product becomes a Product and a ProductVariant).
//
// Bindings are flushed in batches; every create is also appended to the run journal first.
// load() replays the journal on top of bindings.json and flushes, so a crash between two
// flushes loses nothing and the next run skips those objects instead of duplicating them.
// To start over against an empty Vendure, delete bindings.json and the load journals together.
import fs from 'node:fs/promises';
import path from 'node:path';

const FLUSH_EVERY = 100;

export class Bindings {
    // replayFiles defaults to the own journal; the load stage passes every snapshot's journal as
    // bindings.json is shared across snapshots and `all` starts a new snapshot on each run.
    constructor(file, journalFile, replayFiles = [journalFile]) {
        this.file = file;
        this.journalFile = journalFile;
        this.replayFiles = replayFiles;
        this.map = new Map();
        this.dirty = 0;
    }

    static key(entity, sourceId, role) {
        return `shopware|${entity}|${sourceId}|${role}`;
    }

    async load() {
        try {
            const rows = JSON.parse(await fs.readFile(this.file, 'utf8'));
            for (const [k, v] of Object.entries(rows)) this.map.set(k, v);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
        // Oldest journal first, so the newest create wins when a key was bound twice.
        for (const journal of this.replayFiles) await this.replay(journal);
        await this.flush();
        await fs.mkdir(path.dirname(this.journalFile), { recursive: true });
        return this;
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
                await fs.truncate(journal, Buffer.byteLength(text) - Buffer.byteLength(lines[i]));
                continue;
            }
            if (typeof entry.key !== 'string' || typeof entry.targetId !== 'string') {
                throw new Error(`${journal} line ${i + 1} has no string key and targetId`);
            }
            if (this.map.get(entry.key) === entry.targetId) continue;
            this.map.set(entry.key, entry.targetId);
            this.dirty++;
        }
    }

    get(entity, sourceId, role) {
        return this.map.get(Bindings.key(entity, sourceId, role));
    }

    async set(entity, sourceId, role, targetId) {
        const key = Bindings.key(entity, sourceId, role);
        await fs.appendFile(this.journalFile, `${JSON.stringify({ t: new Date().toISOString(), key, targetId: String(targetId) })}\n`);
        this.map.set(key, String(targetId));
        if (++this.dirty >= FLUSH_EVERY) await this.flush();
    }

    async flush() {
        if (!this.dirty) return;
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.map), null, 1), 'utf8');
        await fs.rename(tmp, this.file);
        this.dirty = 0;
    }

    get size() {
        return this.map.size;
    }
}
