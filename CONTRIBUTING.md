# Contributing

## Setup

```bash
pnpm install
```

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm format
pnpm test        # unit + in-memory integration tests, no AWS needed
```

## End-to-end tests (real DynamoDB)

The e2e suite runs the built-in single-table store against a real DynamoDB via
LocalStack:

```bash
docker compose up -d
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test pnpm test:e2e
```

CI runs both the unit and e2e suites on every pull request.

## Releasing

Releases are cut by tagging: bump `version` in `package.json`, update
`CHANGELOG.md`, then push a `v*` tag. The publish workflow builds with tsup and
runs `npm publish --provenance`. Prerelease versions (`x.y.z-alpha.n`) are
published under the matching dist-tag (`alpha`); stable versions get `latest`.

## Testing unreleased changes in an app

Use `pnpm link` (or a `file:` override) from your app to this checkout, run
`pnpm build` here so `dist/` exists, then cut a release when it works.
