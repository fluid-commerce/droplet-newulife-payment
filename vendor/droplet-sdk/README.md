# vendor/droplet-sdk — a temporary copy of `@fluid-studios/droplet-sdk`

This is a **verbatim copy** of the source of
`fluid-commerce/fluid-studios` → `packages/droplet-sdk` (version `0.1.0`),
imported here so this template installs, builds and tests on a clean clone.

## Why it is vendored rather than installed

The SDK is not published. It cannot be published under its current name:
GitHub Packages requires the npm scope to match the repository owner, the
owner is **`fluid-commerce`**, and there is no `fluid-studios` GitHub org, so
`npm publish` of `@fluid-studios/droplet-sdk` to `npm.pkg.github.com` returns
`403 Permission not_found: owner not found`.

Publishing it means renaming the package to `@fluid-commerce/droplet-sdk`.
That rename is deliberately deferred: a number of already-reviewed droplet PRs
depend on the `@fluid-studios` name, and renaming now would invalidate them.

## What to do when it is published

1. Replace the dependency in the root `package.json`:

   ```diff
   -"@fluid-studios/droplet-sdk": "link:./vendor/droplet-sdk",
   +"@fluid-commerce/droplet-sdk": "^0.1.0",
   ```

2. Add an `.npmrc` beside `package.json`:

   ```
   @fluid-commerce:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
   ```

3. Find-and-replace the import specifier `@fluid-studios/droplet-sdk` →
   `@fluid-commerce/droplet-sdk` (12 or so call sites; nothing else changes,
   the API is identical).

4. Delete this directory and drop `vendor/droplet-sdk` from
   `next.config.ts`'s `transpilePackages` and from `tsconfig.json`'s `paths`.

## Do not edit these files

Fixes belong upstream in `packages/droplet-sdk`. A local edit here silently
forks the fleet's signature-verification code, which is the one thing every
droplet must agree on. The `drizzle` adapter and the SDK's own test suite are
intentionally not copied — they are not used by this droplet.
