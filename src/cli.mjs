// Usage: node src/cli.mjs <extract|transform|load|verify|all> [--snapshot <id>]
// Each stage reads the previous stage's files, so stages can be re-run independently.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { log } from './lib/util.mjs';

const [stage, ...rest] = process.argv.slice(2);
const flag = name => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
};

async function latestSnapshot(outDir) {
    const dir = path.join(outDir, 'snapshots');
    const entries = (await fs.readdir(dir).catch(() => [])).sort();
    if (!entries.length) throw new Error('No snapshot found; run extract first.');
    return path.join(dir, entries[entries.length - 1]);
}

async function main() {
    const config = loadConfig();
    const needsNew = stage === 'extract' || stage === 'all';
    const snapshotDir = needsNew
        ? path.join(config.outDir, 'snapshots', new Date().toISOString().replace(/[:.]/g, '-'))
        : flag('snapshot')
          ? path.join(config.outDir, 'snapshots', flag('snapshot'))
          : await latestSnapshot(config.outDir);
    log(`stage=${stage} snapshot=${path.basename(snapshotDir)}`);

    if (stage === 'extract' || stage === 'all') await (await import('./extract.mjs')).extract(config, snapshotDir);
    if (stage === 'transform' || stage === 'all') await (await import('./transform.mjs')).transform(config, snapshotDir);
    if (stage === 'load' || stage === 'all') await (await import('./load.mjs')).load(config, snapshotDir);
    if (stage === 'verify' || stage === 'all') await (await import('./verify.mjs')).verify(config, snapshotDir);
    if (!['extract', 'transform', 'load', 'verify', 'all'].includes(stage)) {
        throw new Error(`Unknown stage "${stage}". Use extract, transform, load, verify or all.`);
    }
}

main().catch(err => {
    console.error(err.stack ?? err);
    if (err.graphqlErrors) console.error(JSON.stringify(err.graphqlErrors, null, 2));
    process.exit(1);
});
