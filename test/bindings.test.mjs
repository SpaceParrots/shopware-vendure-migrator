// Crash recovery of Bindings: a process that dies between two flushes must not lose the
// bindings it already journaled, or the next load run creates those Vendure objects again.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Bindings } from '../src/lib/bindings.mjs';

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
    assert.equal(Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))).length, 150);
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
