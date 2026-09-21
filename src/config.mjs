// All runtime settings come from the environment. Credentials have no defaults on purpose.
import path from 'node:path';

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
}

export function loadConfig() {
    return {
        source: {
            host: process.env.SOURCE_DB_HOST ?? '127.0.0.1',
            port: Number(process.env.SOURCE_DB_PORT ?? 3306),
            database: process.env.SOURCE_DB_NAME ?? 'shopware',
            user: required('SOURCE_DB_USER'),
            password: required('SOURCE_DB_PASSWORD'),
            // Public base URL the storefront serves media from; media.path is relative to it.
            mediaBaseUrl: process.env.SOURCE_MEDIA_BASE_URL ?? 'http://localhost',
            // Free-text identity of the source install, recorded in every manifest.
            label: process.env.SOURCE_LABEL ?? 'unlabelled',
        },
        target: {
            adminApi: process.env.VENDURE_ADMIN_API ?? 'http://localhost:3000/admin-api',
            username: required('VENDURE_USERNAME'),
            password: required('VENDURE_PASSWORD'),
        },
        outDir: path.resolve(process.env.MIGRATOR_OUT_DIR ?? 'out'),
    };
}

// Shopware\Core\Defaults, read from the 6.7 source.
export const SHOPWARE = {
    LIVE_VERSION: '0fa91ce3e96a4bc2be4bd9ce752c3425',
    LANGUAGE_SYSTEM: '2fbb5fe2e29a4d70aa5854ce7ce3e20b',
    CURRENCY: 'b7d2554b0ce847cd82f3ac9bd1c0dfca',
    SALES_CHANNEL_TYPE_STOREFRONT: '8a243080f92e4c719546314b577cf82b',
};
