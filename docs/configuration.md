# Configuration

All settings come from environment variables. Copy `.env.example` to `.env`; it has a one-line comment for every variable. The npm scripts load `.env` if it exists, and variables already set in the shell take precedence. If you call `node src/cli.mjs` directly, set the variables yourself or pass `--env-file=.env`.

## Rules

- **Each stage requires only the credentials it uses.** `transform` and `transform-sales` connect to nothing and need none. `all` runs extract, transform, load and verify, so it needs the source database and Vendure.
- **An empty value counts as unset.**
- **Validation happens up front.** A stage with a missing credential or an invalid value stops before it does anything and names every problem at once.
- **Credentials have no defaults**, on purpose.

| Stage | Requires |
|---|---|
| `extract` | Source database |
| `transform`, `transform-sales` | nothing |
| `load`, `verify` | Vendure |
| `oracle` | Source database, Vendure, Shopware API |
| `all` | Source database, Vendure |
| `load-sales` | Vendure, `VENDURE_CONFIG` |
| `verify-sales` | Source database, Vendure |

## Variables

In the order of `.env.example`, which groups them by the stages that read them.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `SOURCE_DB_HOST` | `127.0.0.1` | extract, oracle, verify-sales | Host of the Shopware database. |
| `SOURCE_DB_PORT` | `3306` | extract, oracle, verify-sales | Port of the Shopware database, an integer from 1 to 65535. |
| `SOURCE_DB_NAME` | `shopware` | extract, oracle, verify-sales | Name of the Shopware database. |
| `SOURCE_DB_USER` | required | extract, oracle, verify-sales | Database user. Read access is enough; give it no more. |
| `SOURCE_DB_PASSWORD` | required | extract, oracle, verify-sales | Password of that user. |
| `SOURCE_LABEL` | `unlabelled` | extract | Free-text name of the source install, written into the extract manifest and from there into the verify report. |
| `SOURCE_MEDIA_BASE_URL` | `http://localhost` | transform, oracle | Public base URL of the shop, http or https. `transform` builds the image URLs in `model.json` from it, which `load` then downloads. `oracle` calls the Admin and Store API under it. |
| `SOURCE_ADMIN_USER` | required | oracle | Shopware admin user for the Admin API login. |
| `SOURCE_ADMIN_PASSWORD` | required | oracle | Password of that admin user. |
| `SOURCE_STORE_ACCESS_KEY` | required | oracle | Store API access key of the storefront sales channel. |
| `VENDURE_ADMIN_API` | `http://localhost:3000/admin-api` | load, verify, oracle, load-sales, verify-sales | URL of the Vendure Admin API, http or https. A trailing slash is dropped. `bindings.json` records it, and a different URL is refused. `verify-sales` derives the Shop API URL by replacing the trailing `admin-api` with `shop-api`. |
| `VENDURE_USERNAME` | required | load, verify, oracle, load-sales, verify-sales | Vendure administrator identifier. |
| `VENDURE_PASSWORD` | required | load, verify, oracle, load-sales, verify-sales | Password of that administrator. |
| `VENDURE_CONFIG` | required | load-sales | Path of the Vendure config module the target server runs with (CommonJS, exporting `config`). `load-sales` boots Vendure in-process with it, so it must point at the same database and declare the same custom fields. |
| `VERIFY_LOGIN_PASSWORD` | unset | verify-sales | Password every migrated customer is expected to log in with. When set, `verify-sales` logs every registered customer into the Shop API. Only useful for demo shops with one known password. |
| `MIGRATOR_HTTP_TIMEOUT_SECONDS` | `30` | load, verify, oracle, verify-sales | Seconds one HTTP attempt may take, including reading the body. A number, 1 or more. |
| `MIGRATOR_HTTP_RETRIES` | `3` | load, verify, oracle, verify-sales | Extra attempts after a timeout, a network error or HTTP 408, 425, 429, 500, 502, 503 or 504, with a wait of 500 ms that doubles each time. Only reads, logins and image downloads retry, never creates. An integer from 0 to 10. |
| `TARGET_LABEL` | `unlabelled` | verify | Free-text name of the target install, written into the verify report. |
| `VERIFY_JOB_WAIT_MINUTES` | `45` | verify | Minutes `verify` waits for the Vendure job queue to drain before it gives up. A number, 0 or more. |
| `MIGRATOR_OUT_DIR` | `out` | every stage | Folder for snapshots and `bindings.json`, relative to the working directory. Use one folder per Vendure target. |

## Output folder

```
out/
├── bindings.json                      # Shopware row -> Vendure id, shared by all snapshots
└── snapshots/
    └── 2026-09-21T19-14-34-278Z/      # one folder per extract
        ├── manifest.extract.json
        ├── raw/*.json
        ├── model.json, decisions.json, gaps.json, diagnostics.json, redirects.csv
        ├── load-journal.ndjson, load-result.json
        ├── verify-report.json, report.md
        ├── oracle-report.json
        ├── sales-model.json, sales-decisions.json, sales-gaps.json
        ├── load-sales-result.json
        └── verify-sales-report.json
```

Stages other than `extract` and `all` use the newest snapshot unless you pass `--snapshot <name>`. Only folders with a timestamp name count as the newest, and `--snapshot` takes a folder name inside `snapshots/`, not a path.

The output folder contains customer data and password hashes once the sales stages have run. See [SECURITY.md](../SECURITY.md).
