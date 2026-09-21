// Source-to-target bindings. The key carries a target role because one Shopware row can
// produce several Vendure objects (a simple product becomes a Product and a ProductVariant).
//
// Bindings are flushed in batches; every create is also appended to the run journal first,
// so a crash between two flushes can be recovered from the journal instead of duplicating.
import fs from 'node:fs/promises';
import path from 'node:path';

const FLUSH_EVERY = 100;

export class Bindings {
    constructor(file, journalFile) {
        this.file = file;
        this.journalFile = journalFile;
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
        await fs.mkdir(path.dirname(this.journalFile), { recursive: true });
        return this;
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
