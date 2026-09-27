// Usage: node src/cli.mjs <extract|transform|load|verify|oracle|all> [--snapshot <id>]
// Each stage reads the previous stage's files, so stages can be re-run independently.
import path from 'node:path';
import { STAGES, latestSnapshot, loadConfig, namedSnapshot, newSnapshotName } from './config.mjs';
import { log, logError } from './lib/util.mjs';

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

  transform-sales  Customers and orders of a transformed snapshot. Writes sales-model.json,
                   sales-decisions.json and sales-gaps.json.
  load-sales       Write customers and orders into Vendure in-process (VENDURE_CONFIG),
                   as finished historical records. Needs the catalogue loaded first.
  verify-sales     Compare Vendure's customers and orders with Shopware, through the
                   Admin and Shop API. Writes verify-sales-report.json.

Flags:
  --snapshot <id>  Snapshot folder under <out>/snapshots/ for every stage but extract
                   and all. Defaults to the newest. extract and all always start a
                   new snapshot.
  -h, --help       Show this help.

Exit code 1 when a stage throws, load or load-sales records failures, verify or
verify-sales has failed checks, or oracle finds resolver mismatches.

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
        throw new Error(`Unknown stage "${stage}". Use ${STAGES.join(', ')}. See --help.`);
    }

    const config = loadConfig(stage);
    const needsNew = stage === 'extract' || stage === 'all';
    const snapshotDir = needsNew
        ? path.join(config.outDir, 'snapshots', newSnapshotName())
        : flag('snapshot')
          ? await namedSnapshot(config.outDir, flag('snapshot'))
          : await latestSnapshot(config.outDir);
    log(`stage=${stage} snapshot=${path.basename(snapshotDir)}`);

    // Stages keep running after a problem so `all` still produces the verify report; the exit
    // code carries the outcome.
    const problems = [];
    if (stage === 'extract' || stage === 'all') await (await import('./extract.mjs')).extract(config, snapshotDir);
    if (stage === 'transform' || stage === 'all') await (await import('./transform.mjs')).transform(config, snapshotDir);
    if (stage === 'load' || stage === 'all') {
        const result = await (await import('./load.mjs')).load(config, snapshotDir);
        if (result.failures.length) problems.push(`load recorded ${result.failures.length} failures (load-result.json)`);
    }
    if (stage === 'verify' || stage === 'all') {
        const report = await (await import('./verify.mjs')).verify(config, snapshotDir);
        const failed = report.checks.filter(x => !x.pass).length;
        if (failed) problems.push(`verify failed ${failed} of ${report.checks.length} checks (verify-report.json)`);
    }
    if (stage === 'transform-sales') await (await import('./transform-sales.mjs')).transformSales(config, snapshotDir);
    if (stage === 'load-sales') {
        const result = await (await import('./load-sales.mjs')).loadSales(config, snapshotDir);
        if (result.failures.length) problems.push(`load-sales recorded ${result.failures.length} failures (load-sales-result.json)`);
    }
    if (stage === 'verify-sales') {
        const report = await (await import('./verify-sales.mjs')).verifySales(config, snapshotDir);
        const failed = report.checks.filter(x => !x.pass).length;
        if (failed) problems.push(`verify-sales failed ${failed} of ${report.checks.length} checks (verify-sales-report.json)`);
    }
    if (stage === 'oracle') {
        const result = await (await import('./oracle.mjs')).oracle(config, snapshotDir);
        if (result.resolverMismatches) problems.push(`oracle found ${result.resolverMismatches} resolver mismatches (oracle-report.json)`);
    }
    if (problems.length) {
        for (const p of problems) logError(`FAILED ${p}`);
        process.exitCode = 1;
    }
}

main().catch(err => {
    logError(err.stack ?? String(err));
    if (err.graphqlErrors) logError(JSON.stringify(err.graphqlErrors, null, 2));
    process.exitCode = 1;
});
