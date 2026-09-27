# Contributing

Thanks for looking into the migrator. It is a small tool with a narrow purpose, so the bar for a change is: it makes a real migration more correct, or it makes a wrong result visible.

## Before you start

- For anything larger than a fix, open an issue first and describe the Shopware data that goes wrong. A migration rule is only right if it matches what Shopware itself shows, so the issue should say what Shopware shows and what the migrator produced.
- Read [docs/architecture.md](docs/architecture.md) for how the stages fit together and where a rule belongs.

## Development setup

```sh
npm install
npm test
```

Node.js 22.9 or later. There is no build step, no transpiler and no linter; the code is plain ES modules (`.mjs`). The tests use `node:test` and need no database or server.

To run the stages end to end you need a Shopware 6.7 shop and a Vendure 3.7 server. [docs/getting-started.md](docs/getting-started.md) describes a local setup, and `scripts/source-scenarios.mjs` gives a demo shop a realistic order history.

## Rules for changes

- **Tests first for behaviour.** A fix comes with a test that fails without it. Transform rules are pure functions over plain objects, so a test builds the Shopware rows it needs by hand; see `test/transform-*.test.mjs`.
- **Refuse rather than guess.** When the source data does not allow a correct result, the migrator refuses the object and reports it (`gaps.json`, `load-result.json`) instead of writing a plausible default. Keep it that way.
- **Never retry a create.** Only reads, logins and downloads may retry; see `src/lib/http.mjs`.
- **Keep the docs true.** Behaviour is documented in `README.md` and `docs/`. A change that alters what a stage does, writes or checks updates the matching page in the same pull request.
- **Style.** Four-space indentation, single quotes, semicolons, small modules. Match the comment density of the file you are in: comments explain *why* a rule is the way it is, usually with the Shopware or Vendure behaviour that forces it.

## Commits and pull requests

- Conventional commit messages: `fix(transform): ...`, `feat(load): ...`, `docs: ...`, `test: ...`, `chore: ...`.
- One concern per pull request. Describe what Shopware data the change affects and how you verified it (tests, and a real run if you did one).
- CI runs `npm test` on Linux and Windows with Node 22 and 24. It must pass.

## Reporting bugs

Use the bug report template. Include the Shopware and Vendure versions, the stage that failed, and the relevant part of `gaps.json`, `load-result.json` or `report.md`. **Do not attach snapshots or reports from a real shop**: they contain product data, and the sales stages contain customer data and password hashes.

Security issues go through [SECURITY.md](SECURITY.md), not public issues.
