// Crash recovery of Bindings: a process that dies between two flushes must not lose the
// bindings it already journaled, or the next load run creates those Vendure objects again.
// Also replay order across snapshots, serialized flushes, empty ids and the recorded target.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { latestSnapshot } from '../src/config.mjs';
import { Bindings, openBindings, snapshotJournals } from '../src/lib/bindings.mjs';

async function tempFiles(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bindings-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return { file: path.join(dir, 'bindings.json'), journal: path.join(dir, 'snap', 'load-journal.ndjson') };
}

test('bindings set after the last flush survive a crash through the journal', async t => {
    const { file, journal } = await tempFiles(t);
    const before = await new Bindings(file, journal).load();
    // 150 sets: one flush at 100, the last 50 exist only in the journal.
    for (let i = 0; i < 150; i++) await before.set('product', `p${i}`, 'product', `v${i}`);
    // No flush() here: the process is treated as crashed.

    const after = await new Bindings(file, journal).load();
    for (let i = 0; i < 150; i++) assert.equal(after.get('product', `p${i}`, 'product'), `v${i}`, `key p${i}`);
    assert.equal(after.size, 150);
    // The replay is written back, so bindings.json alone is current again.
    assert.equal(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).bindings).length, 150);
});

test('a torn final journal line is skipped and cut off for the next append', async t => {
    const { file, journal } = await tempFiles(t);
    const b = await new Bindings(file, journal).load();
    for (let i = 0; i < 3; i++) await b.set('country', `c${i}`, 'country', `${i}`);
    await fs.appendFile(journal, '{"t":"2026-09-22T00:00:00.000Z","key":"shopware|coun');

    const after = await new Bindings(file, journal).load();
    assert.equal(after.size, 3);
    assert.equal(after.get('country', 'c2', 'country'), '2');

    // The resumed run appends to the same journal; the torn tail must not break that line.
    await after.set('country', 'c3', 'country', '3');
    const resumed = await new Bindings(file, journal).load();
    assert.equal(resumed.get('country', 'c3', 'country'), '3');
});

test('an unparseable journal line that is not the last one throws', async t => {
    const { file, journal } = await tempFiles(t);
    await fs.mkdir(path.dirname(journal), { recursive: true });
    await fs.writeFile(journal, '{"t":"x","key":"a","targetId":"1"}\n{"t":"x","key":\n{"t":"x","key":"b","targetId":"2"}\n');
    await assert.rejects(new Bindings(file, journal).load(), /line 2 is not valid JSON/);
});

// ----- journal discovery and replay order ------------------------------------------------------

async function outDir(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bindings-out-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
}
const TARGET = 'http://vendure-a:3000/admin-api';
const config = dir => ({ outDir: dir, target: { adminApi: TARGET } });
async function writeJournal(dir, snapshot, entries) {
    const file = path.join(dir, 'snapshots', snapshot, 'load-journal.ndjson');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, entries.map(e => `${JSON.stringify({ t: 'x', ...e })}\n`).join(''));
    return file;
}

test('snapshot journals replay oldest first with the current snapshot last', async t => {
    const dir = await outDir(t);
    const key = Bindings.key('product', 'p1', 'product');
    await writeJournal(dir, '2026-09-20T10-00-00-000Z', [{ key, targetId: '1' }]);
    await writeJournal(dir, '2026-09-21T10-00-00-000Z', [{ key, targetId: '2' }]);
    await writeJournal(dir, '2026-09-22T10-00-00-000Z', [{ key, targetId: '3' }]);
    await fs.writeFile(path.join(dir, 'snapshots', 'stray-file.txt'), 'not a snapshot');

    const current = path.join(dir, 'snapshots', '2026-09-21T10-00-00-000Z');
    const order = (await snapshotJournals(dir, current)).map(f => path.basename(path.dirname(f)));
    assert.deepEqual(order, ['2026-09-20T10-00-00-000Z', '2026-09-22T10-00-00-000Z', '2026-09-21T10-00-00-000Z']);
    assert.equal((await openBindings(config(dir), current, { readOnly: true })).get('product', 'p1', 'product'), '2');
    const newest = path.join(dir, 'snapshots', '2026-09-22T10-00-00-000Z');
    assert.equal((await openBindings(config(dir), newest, { readOnly: true })).get('product', 'p1', 'product'), '3');
});

test('journal discovery skips the snapshot folders latestSnapshot skips, except the current one', async t => {
    const dir = await outDir(t);
    const key = Bindings.key('product', 'p1', 'product');
    await writeJournal(dir, '2026-09-20T10-00-00-000Z', [{ key, targetId: '1' }]);
    // Sorts after every timestamp, so replaying it would make its binding win.
    await writeJournal(dir, 'zz-backup', [{ key, targetId: 'stale' }]);
    await writeJournal(dir, 'custom', [{ key: Bindings.key('product', 'p2', 'product'), targetId: '7' }]);

    const newest = await latestSnapshot(dir);
    assert.deepEqual((await snapshotJournals(dir, newest)).map(f => path.basename(path.dirname(f))), ['2026-09-20T10-00-00-000Z']);
    assert.equal((await openBindings(config(dir), newest, { readOnly: true })).get('product', 'p1', 'product'), '1');

    // A folder named with --snapshot is still the current snapshot, so its own journal is replayed last.
    const custom = path.join(dir, 'snapshots', 'custom');
    assert.deepEqual((await snapshotJournals(dir, custom)).map(f => path.basename(path.dirname(f))), ['2026-09-20T10-00-00-000Z', 'custom']);
    const b = await openBindings(config(dir), custom, { readOnly: true });
    assert.equal(b.get('product', 'p1', 'product'), '1');
    assert.equal(b.get('product', 'p2', 'product'), '7');
});

test('a read-only open sees unflushed journals but writes nothing', async t => {
    const dir = await outDir(t);
    const snap = path.join(dir, 'snapshots', '2026-09-20T10-00-00-000Z');
    const journalFile = await writeJournal(dir, '2026-09-20T10-00-00-000Z', [{ key: Bindings.key('media', 'm1', 'asset'), targetId: '7' }]);
    await fs.appendFile(journalFile, '{"t":"x","key":"shop');
    const before = await fs.readFile(journalFile, 'utf8');

    const b = await openBindings(config(dir), snap, { readOnly: true });
    assert.equal(b.get('media', 'm1', 'asset'), '7');
    await b.flush();
    await assert.rejects(b.set('media', 'm2', 'asset', '8'), /read-only/);
    assert.equal(await fs.readFile(journalFile, 'utf8'), before, 'the torn line is left for the next load to repair');
    await assert.rejects(fs.stat(path.join(dir, 'bindings.json')), { code: 'ENOENT' });
});

// ----- concurrent set and flush -----------------------------------------------------------------

test('concurrent set and flush lose no binding', async t => {
    const { file, journal } = await tempFiles(t);
    const b = await new Bindings(file, journal).load();
    const work = [];
    for (let i = 0; i < 250; i++) {
        work.push(b.set('product', `p${i}`, 'variant', `v${i}`));
        if (i % 30 === 0) work.push(b.flush());
    }
    await Promise.all(work);
    await b.flush();
    assert.equal(b.dirty, 0);
    // Read bindings.json alone, without the journal, to see what the flushes wrote.
    const fromFile = await new Bindings(file, journal, []).load();
    assert.equal(fromFile.size, 250);
    const lines = (await fs.readFile(journal, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 250);
    for (const line of lines) JSON.parse(line);
});

test('a set that lands while a flush is writing is saved by the next flush', async t => {
    const { file, journal } = await tempFiles(t);
    const b = await new Bindings(file, journal).load();
    await b.set('country', 'c0', 'country', '1');
    // Hold the write open until the second set has finished.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const persist = b.persist.bind(b);
    b.persist = async text => { await gate; return persist(text); };
    const flushing = b.flush();
    await b.set('country', 'c1', 'country', '2');
    release();
    await flushing;
    b.persist = persist;
    assert.equal(b.dirty, 1, 'the set during the write is still unsaved');
    await b.flush();
    const fromFile = await new Bindings(file, journal, []).load();
    assert.equal(fromFile.get('country', 'c1', 'country'), '2');
});

// ----- empty target ids -------------------------------------------------------------------------

test('set refuses an empty target id and journals nothing', async t => {
    const { file, journal } = await tempFiles(t);
    const b = await new Bindings(file, journal).load();
    for (const id of [undefined, null, '', 'undefined']) {
        await assert.rejects(b.set('propertyOption', 'o1', 'facetValue', id), /Refusing to bind .*o1/);
    }
    assert.equal(b.get('propertyOption', 'o1', 'facetValue'), undefined);
    await assert.rejects(fs.readFile(journal, 'utf8'), { code: 'ENOENT' });
});

test('replay rejects a journal entry with an empty target id', async t => {
    const { file, journal } = await tempFiles(t);
    await fs.mkdir(path.dirname(journal), { recursive: true });
    await fs.writeFile(journal, '{"t":"x","key":"shopware|productOption|f|o|option","targetId":"undefined"}\n');
    await assert.rejects(new Bindings(file, journal).load(), /line 1 binds shopware\|productOption\|f\|o\|option to the empty id "undefined"/);
});

test('load rejects bindings.json with an empty target id', async t => {
    const { file, journal } = await tempFiles(t);
    await fs.writeFile(file, JSON.stringify({ target: TARGET, bindings: { 'shopware|x|1|y': 'undefined' } }));
    await assert.rejects(new Bindings(file, journal).load(), /bindings\.json binds shopware\|x\|1\|y to the empty id/);
});

// ----- target URL -------------------------------------------------------------------------------

test('bindings.json records the target and refuses another one', async t => {
    const dir = await outDir(t);
    const snap = path.join(dir, 'snapshots', '2026-09-20T10-00-00-000Z');
    const b = await openBindings(config(dir), snap);
    await b.set('country', 'de', 'country', '1');
    await b.flush();
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'bindings.json'), 'utf8')).target, TARGET);

    const other = { outDir: dir, target: { adminApi: 'http://vendure-b:3000/admin-api' } };
    await assert.rejects(openBindings(other, snap), /bindings\.json was written for the Vendure Admin API at http:\/\/vendure-a.*this run targets http:\/\/vendure-b/);
    // A trailing slash is the same target.
    await openBindings({ outDir: dir, target: { adminApi: `${TARGET}/` } }, snap, { readOnly: true });
});

test('a journal written for another target is refused', async t => {
    const dir = await outDir(t);
    await writeJournal(dir, '2026-09-20T10-00-00-000Z', [{ key: 'shopware|country|de|country', targetId: '1', target: 'http://elsewhere/admin-api' }]);
    const snap = path.join(dir, 'snapshots', '2026-09-21T10-00-00-000Z');
    await assert.rejects(openBindings(config(dir), snap), /load-journal\.ndjson line 1 was written for the Vendure Admin API at http:\/\/elsewhere/);
});

test('a bindings.json from before the target was recorded is adopted and upgraded', async t => {
    const dir = await outDir(t);
    await fs.writeFile(path.join(dir, 'bindings.json'), JSON.stringify({ 'shopware|country|de|country': '1' }));
    const b = await openBindings(config(dir), path.join(dir, 'snapshots', '2026-09-20T10-00-00-000Z'));
    assert.equal(b.get('country', 'de', 'country'), '1');
    const written = JSON.parse(await fs.readFile(path.join(dir, 'bindings.json'), 'utf8'));
    assert.deepEqual(written, { target: TARGET, bindings: { 'shopware|country|de|country': '1' } });
});
