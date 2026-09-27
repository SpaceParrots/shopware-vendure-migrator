# Bindings and re-runs

## The binding table

`bindings.json` in the output folder maps each Shopware row to the Vendure object created from it. A key looks like `shopware|product|<source id>|variant`; the role at the end exists because one Shopware row can become several Vendure objects.

`load` and `load-sales` skip every source row that already has a binding, so running them again after a failure continues where they stopped instead of creating duplicates. The file is shared by all snapshots.

## One output folder per Vendure

`bindings.json` and every journal line record the Admin API URL they were written for. Ids from one Vendure mean nothing in another, so `load`, `verify` and `oracle` refuse to run when `VENDURE_ADMIN_API` differs. Use a separate `MIGRATOR_OUT_DIR` per target.

A `bindings.json` from before the URL was recorded is adopted for the current URL.

## Crash safety

Bindings are written to `bindings.json` in batches of 100 and at the end of each step. Every create is also appended to the snapshot's `load-journal.ndjson` right after Vendure returns the new id.

When `load` starts, it replays the journals of all snapshots, oldest first, on top of `bindings.json` and saves the result. Only timestamp-named snapshot folders count, the same rule as for the newest snapshot; the current snapshot's journal is always replayed last, also when `--snapshot` names a folder without a timestamp.

- A crash between two batches therefore loses no bindings.
- If the crash cut the last journal line in half, that line is dropped and cut from the file.
- A binding to an empty id is refused.

`verify` and `oracle` replay the same journals read-only and write nothing back.

### The remaining window

A crash after Vendure created an object but before its journal line was written leaves that object without a binding. The next run creates it again. This affects only the requests in flight at that moment: up to four at once for assets and for products, and one variant request covers all missing variants of a product.

For this reason creates are never retried on a timeout: a create that timed out may still have been applied, and sending it again would create a second object no binding points to. Only reads, logins and image downloads retry.

## Create and skip only

A bound object is never updated. Changes made in Shopware after the first load do not reach Vendure; re-running `load` only creates what is still missing. For a final cut-over, start over on a fresh Vendure with a new extract.

## Starting over

Empty Vendure, and delete `bindings.json` together with all `load-journal.ndjson` files (or the whole output folder). Deleting only one of them brings back bindings to objects that no longer exist, or loses bindings to objects that do.
