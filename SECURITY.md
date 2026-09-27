# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's [private vulnerability reporting](https://github.com/kevmtt/shopware-vendure-migrator/security/advisories/new) for this repository. Do not open a public issue.

Include what an attacker controls, what they gain, and the steps to reproduce. You will get an answer within a week.

## Supported versions

Only the latest commit on `master` is supported. There are no maintained release branches.

## Trust model

The migrator is a command-line tool run by the operator of both shops. It trusts:

- **The environment and `.env`.** Credentials, URLs and the output folder come from there.
- **The Shopware database.** Every row is treated as the operator's own data. In particular, `load` downloads product images from URLs built from `SOURCE_MEDIA_BASE_URL` and the paths in Shopware's `media` table, without an allow-list of hosts.
- **The Vendure config module.** `load-sales` imports the module named by `VENDURE_CONFIG` and boots Vendure in-process, so that file runs with the migrator's permissions.

## Handling the output

The output folder (`out/` or `MIGRATOR_OUT_DIR`) holds a full copy of the extracted data:

- `raw/*.json` and `model.json` contain the catalogue.
- The sales snapshot files and `sales-model.json` contain customer names, email addresses, postal addresses, order history **and the customers' bcrypt password hashes**.

Treat the output folder like a database dump: keep it off shared drives, never commit it (it is in `.gitignore`), and delete it when the migration is done. Never attach it to an issue.

The database user in `SOURCE_DB_USER` needs read access only; give it no more.

`scripts/source-scenarios.mjs` **writes** to the shop it points at. Run it only against a throwaway demo shop.
