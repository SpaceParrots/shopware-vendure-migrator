# Documentation

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Requirements, installation, a first migration from start to finish. |
| [Configuration](configuration.md) | Every environment variable, its default and the stages that read it. |
| [Preparing the Vendure target](vendure-target.md) | What the Vendure server must have: auth, plugins, custom fields, money and tax strategies. |
| [Catalogue migration](catalogue.md) | The stages `extract`, `transform`, `load`, `verify` and `oracle`: what each reads, does, checks and writes. |
| [Customers and orders](customers-and-orders.md) | The stages `transform-sales`, `load-sales` and `verify-sales`. |
| [Bindings and re-runs](bindings-and-reruns.md) | How the migrator remembers what it created, recovers from crashes and starts over. |
| [Coverage and limits](coverage-and-limits.md) | What is migrated, what is not, and the known limits. |
| [Architecture](architecture.md) | Code layout, data flow and the design rules the code follows. |
| [Testing](testing.md) | The test suite and how to prepare a demo shop for an end-to-end run. |

Start with [Getting started](getting-started.md). Before a real migration, read [Coverage and limits](coverage-and-limits.md) and run `transform` once: `gaps.json` tells you what applies to your shop.
