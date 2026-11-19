# npm publish attempt — SDK 0.1.0 (2026-11-19)

Attempted package: `@dfr/sdk-typescript@0.1.0` (with `@dfr/types@0.1.0` as its dependency).
Registry: `https://registry.npmjs.org/`. `npm whoami` = `dfrchain-admin`; `~/.npmrc` remains mode
`600` and its token is never printed or committed.

## Result: BLOCKED by scope authorization

```
$ npm publish --access public        # from the @dfr/types staging dir
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/@dfr%2ftypes - Not found
npm error 404  '@dfr/types@0.1.0' is not in this registry.
```

npm reports 404 for a scope that does not exist **or** that the token may not publish to; the exact
status is `E404` on `PUT /@dfr%2ftypes`. Per the task instruction, the package was **not renamed** and
no alternative scope was used. Publishing `@dfr/sdk-typescript` was not attempted after the scope
failure, since it depends on `@dfr/types`.

## Publish-ready artifacts (verified locally)

| File | sha256 |
|---|---|
| `dfr-types-0.1.0.tgz` | `c64eacb0b25f9e056d529ae83b4df812f96ab6bb7f82df1b5cfc85f5b4c360b3` |
| `dfr-sdk-typescript-0.1.0.tgz` | `75b5fce84c3c1a5f9f22a6106146268aa09630b770d9f837fe697d4d79914a41` |

Clean-directory check (`npm i <both tarballs>`): `added 2 packages`; Node ESM import exposes
`DfrClient`; `tsc` consumer importing `DfrClient` + `UsageResponse` passes. Staging metadata used
`dist` entry points, no `private`, and `@dfr/types: 0.1.0`; the repository stays workspace-oriented
(`workspace:*` + `publishConfig`) so the monorepo remains installable.

## Unblock options (owner decision)

1. Create/claim the `@dfr` npm org and grant `dfrchain-admin` publish rights, then rerun the same
   two publishes.
2. Supply a token from an account that already owns the `@dfr` scope.
3. Approve a different public scope/name (requires an explicit naming decision — not done here).

No CI or release scripts were changed.
