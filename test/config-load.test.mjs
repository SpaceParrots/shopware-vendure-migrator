// loadConfig requires only the credentials a stage uses and rejects malformed numbers and URLs;
// the snapshot helpers only accept folders inside <out>/snapshots.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { latestSnapshot, loadConfig, namedSnapshot, newSnapshotName, SNAPSHOT_NAME } from '../src/config.mjs';

const DB = { SOURCE_DB_USER: 'u', SOURCE_DB_PASSWORD: 'p' };
const VENDURE = { VENDURE_USERNAME: 'admin', VENDURE_PASSWORD: 'secret' };
const SHOPWARE_API = { SOURCE_ADMIN_USER: 'a', SOURCE_ADMIN_PASSWORD: 'b', SOURCE_STORE_ACCESS_KEY: 'k' };

test('transform needs no credentials', () => {
    const config = loadConfig('transform', {});
    assert.equal(config.source.user, undefined);
    assert.equal(config.target.username, undefined);
    assert.equal(config.source.mediaBaseUrl, 'http://localhost');
});

test('each stage requires exactly its own credentials', () => {
    assert.doesNotThrow(() => loadConfig('extract', DB));
    assert.throws(() => loadConfig('extract', VENDURE), /SOURCE_DB_USER is required for extract/);
    assert.doesNotThrow(() => loadConfig('load', VENDURE));
    assert.throws(() => loadConfig('load', DB), /VENDURE_USERNAME is required for load[\s\S]*VENDURE_PASSWORD/);
    assert.doesNotThrow(() => loadConfig('verify', VENDURE));
    assert.doesNotThrow(() => loadConfig('all', { ...DB, ...VENDURE }));
    assert.throws(() => loadConfig('all', VENDURE), /SOURCE_DB_USER/);
    assert.throws(() => loadConfig('oracle', { ...DB, ...VENDURE }), /SOURCE_ADMIN_USER[\s\S]*SOURCE_STORE_ACCESS_KEY/);
    const oracle = loadConfig('oracle', { ...DB, ...VENDURE, ...SHOPWARE_API });
    assert.equal(oracle.source.storeAccessKey, 'k');
});

test('an empty value counts as unset', () => {
    assert.throws(() => loadConfig('load', { VENDURE_USERNAME: '', VENDURE_PASSWORD: 'x' }), /VENDURE_USERNAME is required/);
    assert.equal(loadConfig('transform', { SOURCE_DB_PORT: '' }).source.port, 3306);
});

test('numbers must be finite and ports integers', () => {
    assert.throws(() => loadConfig('transform', { SOURCE_DB_PORT: '33o6' }), /SOURCE_DB_PORT must be an integer/);
    assert.throws(() => loadConfig('transform', { SOURCE_DB_PORT: '70000' }), /SOURCE_DB_PORT/);
    assert.throws(() => loadConfig('transform', { VERIFY_JOB_WAIT_MINUTES: 'Infinity' }), /VERIFY_JOB_WAIT_MINUTES must be a finite number/);
    assert.throws(() => loadConfig('transform', { MIGRATOR_HTTP_RETRIES: '1.5' }), /MIGRATOR_HTTP_RETRIES must be an integer/);
    assert.throws(() => loadConfig('transform', { MIGRATOR_HTTP_TIMEOUT_SECONDS: '0' }), /MIGRATOR_HTTP_TIMEOUT_SECONDS/);
    const config = loadConfig('transform', { SOURCE_DB_PORT: '3307', VERIFY_JOB_WAIT_MINUTES: '1.5', MIGRATOR_HTTP_TIMEOUT_SECONDS: '10', MIGRATOR_HTTP_RETRIES: '0' });
    assert.equal(config.source.port, 3307);
    assert.equal(config.verify.jobWaitMs, 90_000);
    assert.equal(config.http.timeoutMs, 10_000);
    assert.equal(config.http.retries, 0);
});

test('URLs must be http(s); the Vendure URL loses its trailing slash', () => {
    assert.throws(() => loadConfig('transform', { VENDURE_ADMIN_API: 'localhost:3000' }), /VENDURE_ADMIN_API must be an http\(s\) URL/);
    assert.throws(() => loadConfig('transform', { SOURCE_MEDIA_BASE_URL: 'ftp://x' }), /SOURCE_MEDIA_BASE_URL/);
    assert.equal(loadConfig('transform', { VENDURE_ADMIN_API: 'http://v:3000/admin-api/' }).target.adminApi, 'http://v:3000/admin-api');
});

test('all problems are reported together', () => {
    assert.throws(() => loadConfig('load', { SOURCE_DB_PORT: 'x' }), /SOURCE_DB_PORT[\s\S]*VENDURE_USERNAME[\s\S]*VENDURE_PASSWORD/);
});

test('every variable loadConfig reads is listed in .env.example', async () => {
    const example = await fs.readFile(new URL('../.env.example', import.meta.url), 'utf8');
    const listed = new Set([...example.matchAll(/^([A-Z0-9_]+)=/gm)].map(m => m[1]));
    const read = new Set();
    const spy = new Proxy({}, { get: (_, name) => { if (typeof name === 'string') read.add(name); return undefined; } });
    loadConfig('transform', spy);
    assert.deepEqual([...read].filter(name => !listed.has(name)), []);
    for (const line of example.split('\n').filter(l => /^[A-Z0-9_]+=/.test(l))) {
        const [name, value] = line.split('=');
        if (/USER|PASSWORD|KEY/.test(name)) assert.equal(value.trim(), 'changeme', `${name} is a placeholder`);
    }
});

async function outDir(t, names) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    for (const name of names) await fs.mkdir(path.join(dir, 'snapshots', name), { recursive: true });
    return dir;
}

test('latestSnapshot only considers timestamp-named folders', async t => {
    const dir = await outDir(t, ['2026-09-20T10-00-00-000Z', '2026-09-21T10-00-00-000Z', 'zz-backup']);
    await fs.writeFile(path.join(dir, 'snapshots', '2026-09-22T10-00-00-000Z'), 'a file, not a folder');
    assert.equal(path.basename(await latestSnapshot(dir)), '2026-09-21T10-00-00-000Z');
    await assert.rejects(latestSnapshot(await outDir(t, ['backup'])), /No snapshot found/);
});

test('namedSnapshot rejects names that leave the snapshots folder', async t => {
    const dir = await outDir(t, ['2026-09-20T10-00-00-000Z', 'custom']);
    assert.equal(path.basename(await namedSnapshot(dir, 'custom')), 'custom');
    await assert.rejects(namedSnapshot(dir, '../custom'), /must be a folder name/);
    await assert.rejects(namedSnapshot(dir, '..'), /must be a folder name/);
    await assert.rejects(namedSnapshot(dir, 'custom/../../x'), /must be a folder name/);
    await assert.rejects(namedSnapshot(dir, path.resolve(dir, 'elsewhere')), /must be a folder name/);
    await assert.rejects(namedSnapshot(dir, 'missing'), /does not exist/);
});

test('new snapshot names match the pattern latestSnapshot looks for', () => {
    assert.match(newSnapshotName(new Date('2026-09-22T10:11:12.345Z')), SNAPSHOT_NAME);
});
