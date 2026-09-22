// Usage: node src/cli.mjs <extract|transform|load|verify|oracle|all> [--snapshot <id>]
// Each stage reads the previous stage's files, so stages can be re-run independently.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { log } from './lib/util.mjs';

const STAGES = ['extract', 'transform', 'load', 'verify', 'oracle', 'all'];

const USAGE = `Usage: node src/cli.mjs <stage> [--snapshot <id>]
       npm run <stage> [-- --snapshot <id>]

Stages:
  extract    Read the Shopware catalogue from MySQL into a new snapshot (raw/*.json).
  transform  Resolve inheritance, translations and tax zones. Writes model.json,
             decisions.json, gaps.json, diagnostics.json and redirects.csv.
  load       Create the model in Vendure through the Admin API. Skips everything
             already recorded in bindings.json.
  verify     Compare Vendure with model.json. Writes verify-report.json and report.md.
  oracle     Compare the model and Vendure with Shopware's own Admin and Store API.
             Writes oracle-report.json.
  all        extract, transform, load and verify, on a new snapshot.

Flags:
  --snapshot <id>  Snapshot folder under <out>/snapshots/ for transform, load, verify
                   and oracle. Defaults to the newest. extract and all always start
                   a new snapshot.
  -h, --help       Show this help.

Settings come from environment variables; see .env.example.
`;

const [stage, ...rest] = process.argv.slice(2);
const flag = name => {
    const i = rest.indexOf(`--${name}`);
    if (i < 0) return undefined;
    // Without this check a trailing --snapshot would silently fall back to the newest snapshot.
    if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`--${name} needs a value.`);
    return rest[i + 1];
};

async function latestSnapshot(outDir) {
    const dir = path.join(outDir, 'snapshots');
    const entries = (await fs.readdir(dir).catch(() => [])).sort();
    if (!entries.length) throw new Error('No snapshot found; run extract first.');
    return path.join(dir, entries[entries.length - 1]);
}

async function main() {
    if (stage === '--help' || stage === '-h' || stage === 'help') {
        process.stdout.write(USAGE);
        return;
    }
    if (!stage) {
        process.stderr.write(USAGE);
        process.exitCode = 1;
        return;
    }
    // Checked before loadConfig, so a typo does not first complain about missing credentials.
    if (!STAGES.includes(stage)) {
        throw new Error(`Unknown stage "${stage}". Use extract, transform, load, verify, oracle or all. See --help.`);
    }

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
    if (stage === 'oracle') await (await import('./oracle.mjs')).oracle(config, snapshotDir);
}

main().catch(err => {
    console.error(err.stack ?? err);
    if (err.graphqlErrors) console.error(JSON.stringify(err.graphqlErrors, null, 2));
    process.exit(1);
});
