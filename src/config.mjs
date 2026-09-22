// All runtime settings come from the environment, read and validated here and nowhere else.
// Credentials have no defaults on purpose, and each stage requires only the ones it uses.
import fs from 'node:fs/promises';
import path from 'node:path';

/** Credential groups each stage connects with. */
const STAGE_NEEDS = {
    extract: ['sourceDb'],
    transform: [],
    load: ['vendure'],
    verify: ['vendure'],
    oracle: ['sourceDb', 'vendure', 'shopwareApi'],
    all: ['sourceDb', 'vendure'],
};
export const STAGES = Object.keys(STAGE_NEEDS);

const CREDENTIALS = {
    sourceDb: ['SOURCE_DB_USER', 'SOURCE_DB_PASSWORD'],
    vendure: ['VENDURE_USERNAME', 'VENDURE_PASSWORD'],
    shopwareApi: ['SOURCE_ADMIN_USER', 'SOURCE_ADMIN_PASSWORD', 'SOURCE_STORE_ACCESS_KEY'],
};

/**
 * Reads every setting of the migrator from the environment.
 *
 * @param {string} stage One of STAGES; decides which credentials are required. transform needs
 *   none, extract the source database, load and verify Vendure, oracle all three groups, and all
 *   the source database and Vendure.
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{
 *   source: { host: string, port: number, database: string, user?: string, password?: string,
 *     mediaBaseUrl: string, label: string, adminUser?: string, adminPassword?: string, storeAccessKey?: string },
 *   target: { adminApi: string, username?: string, password?: string, label: string },
 *   http: { timeoutMs: number, retries: number, retryDelayMs: number },
 *   verify: { jobWaitMs: number },
 *   outDir: string,
 * }} Credentials a stage does not need are included when set and undefined otherwise.
 * @throws {Error} Naming every missing credential and every invalid value at once, or an
 *   unknown stage.
 */
export function loadConfig(stage, env = process.env) {
    if (!STAGE_NEEDS[stage]) throw new Error(`Unknown stage "${stage}". Use ${STAGES.join(', ')}.`);
    const problems = [];
    // An empty value counts as unset, so `VAR=` in .env falls back to the default.
    const read = name => (env[name] === undefined || env[name] === '' ? undefined : env[name]);
    const needed = new Set(STAGE_NEEDS[stage].flatMap(group => CREDENTIALS[group]));
    const credential = name => {
        const value = read(name);
        if (value === undefined && needed.has(name)) problems.push(`${name} is required for ${stage}`);
        return value;
    };
    const number = (name, fallback, { integer = false, min = -Infinity, max = Infinity } = {}) => {
        const raw = read(name);
        if (raw === undefined) return fallback;
        const value = Number(raw);
        if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
            const range = `${min === -Infinity ? '' : `>= ${min}`}${min !== -Infinity && max !== Infinity ? ' and ' : ''}${max === Infinity ? '' : `<= ${max}`}`;
            problems.push(`${name} must be ${integer ? 'an integer' : 'a finite number'}${range ? ` ${range}` : ''}, got "${raw}"`);
            return fallback;
        }
        return value;
    };
    const url = (name, fallback) => {
        const value = read(name) ?? fallback;
        try {
            const parsed = new URL(value);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http(s)');
        } catch {
            problems.push(`${name} must be an http(s) URL, got "${value}"`);
        }
        return value;
    };

    const config = {
        source: {
            host: read('SOURCE_DB_HOST') ?? '127.0.0.1',
            port: number('SOURCE_DB_PORT', 3306, { integer: true, min: 1, max: 65535 }),
            database: read('SOURCE_DB_NAME') ?? 'shopware',
            user: credential('SOURCE_DB_USER'),
            password: credential('SOURCE_DB_PASSWORD'),
            // Public base URL the storefront serves media from; media.path is relative to it.
            mediaBaseUrl: url('SOURCE_MEDIA_BASE_URL', 'http://localhost'),
            // Free-text identity of the source install, recorded in every manifest.
            label: read('SOURCE_LABEL') ?? 'unlabelled',
            adminUser: credential('SOURCE_ADMIN_USER'),
            adminPassword: credential('SOURCE_ADMIN_PASSWORD'),
            storeAccessKey: credential('SOURCE_STORE_ACCESS_KEY'),
        },
        target: {
            // Trailing slashes are dropped so the bindings check compares one spelling per URL.
            adminApi: url('VENDURE_ADMIN_API', 'http://localhost:3000/admin-api').replace(/\/+$/, ''),
            username: credential('VENDURE_USERNAME'),
            password: credential('VENDURE_PASSWORD'),
            label: read('TARGET_LABEL') ?? 'unlabelled',
        },
        http: {
            timeoutMs: number('MIGRATOR_HTTP_TIMEOUT_SECONDS', 30, { min: 1 }) * 1000,
            retries: number('MIGRATOR_HTTP_RETRIES', 3, { integer: true, min: 0, max: 10 }),
            retryDelayMs: 500,
        },
        verify: {
            jobWaitMs: number('VERIFY_JOB_WAIT_MINUTES', 45, { min: 0 }) * 60 * 1000,
        },
        outDir: path.resolve(read('MIGRATOR_OUT_DIR') ?? 'out'),
    };
    if (problems.length) throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}\nSee .env.example.`);
    return config;
}

// ----- snapshots ----------------------------------------------------------------------------

/** Name extract and all give a new snapshot: the ISO time with ':' and '.' replaced. */
export const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** @returns {string} Snapshot folder name for the given moment. */
export function newSnapshotName(now = new Date()) {
    return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Snapshot folders under <outDir>/snapshots, oldest first. Only timestamp-named folders count,
 * so a copied or hand-made folder such as `backup` is neither picked as the newest snapshot nor
 * replayed as a load journal. Timestamp names sort in creation order.
 * @param {string} outDir
 * @returns {Promise<string[]>} Absolute paths; empty when the snapshots folder does not exist.
 */
export async function snapshotFolders(outDir) {
    const dir = path.resolve(outDir, 'snapshots');
    return (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
        .filter(e => e.isDirectory() && SNAPSHOT_NAME.test(e.name))
        .map(e => e.name)
        .sort()
        .map(name => path.join(dir, name));
}

/**
 * The newest snapshot folder, by the rule of snapshotFolders.
 * @param {string} outDir
 * @returns {Promise<string>} Absolute path of the snapshot folder.
 * @throws {Error} When no snapshot exists.
 */
export async function latestSnapshot(outDir) {
    const folders = await snapshotFolders(outDir);
    if (!folders.length) throw new Error(`No snapshot found in ${path.resolve(outDir, 'snapshots')}; run extract first.`);
    return folders[folders.length - 1];
}

/**
 * The snapshot folder named on the command line.
 * @param {string} outDir
 * @param {string} name Folder name directly under <outDir>/snapshots.
 * @returns {Promise<string>} Absolute path of the snapshot folder.
 * @throws {Error} When the name is not a single folder name inside the snapshots folder (for
 *   example `../x` or an absolute path), or the folder does not exist.
 */
export async function namedSnapshot(outDir, name) {
    const dir = path.resolve(outDir, 'snapshots');
    const resolved = path.resolve(dir, name);
    if (path.dirname(resolved) !== dir) {
        throw new Error(`--snapshot "${name}" must be a folder name inside ${dir}, not a path.`);
    }
    const stat = await fs.stat(resolved).catch(() => undefined);
    if (!stat?.isDirectory()) throw new Error(`Snapshot ${resolved} does not exist.`);
    return resolved;
}

// Shopware\Core\Defaults, read from the 6.7 source.
export const SHOPWARE = {
    LIVE_VERSION: '0fa91ce3e96a4bc2be4bd9ce752c3425',
    LANGUAGE_SYSTEM: '2fbb5fe2e29a4d70aa5854ce7ce3e20b',
    CURRENCY: 'b7d2554b0ce847cd82f3ac9bd1c0dfca',
    SALES_CHANNEL_TYPE_STOREFRONT: '8a243080f92e4c719546314b577cf82b',
};
