# Contributing

Thanks for looking. A few things that will save you time.

## What lives here

This repository is the **runtime only** — the frame conductor, the sensor and
governor layer, the scene-policy hooks, and the React/R3F adapters. It is
Apache 2.0 from 4.3.0 onward (MIT up to 4.2.0) and published as
[`@vectorvesper/motion`](https://www.npmjs.com/package/@vectorvesper/motion).

The Vector Vesper *component catalogue* is a separate, commercial product and is
not in this repository. Issues about a specific component belong on the
storefront, not here.

## Running it

```bash
npm install
npm run typecheck
npm test          # 250 tests, node + jsdom
npm run build     # tsup, then two post-build guards
npm run check:api # diffs the built .d.ts against api-surface.json
```

`npm run build` must pass before `check:api` means anything — it reads the
built types, not the source.

## The API surface is frozen on purpose

`check:api` compares the built declarations against `api-surface.json`, by
**name and shape**. If your change alters the public surface it will fail, and
that is the point: the snapshot is updated deliberately, in the same commit,
so a surface change is always visible in review.

## The browser harnesses are not in CI

```bash
npm run test:pressure    # classifies four loads in a real Chrome, at 1x/4x/6x CPU
npm run test:scheduling  # MessageChannel ordering against real rendering steps
npm run bench            # the trade, not just the win
```

These launch a **visible** Chrome and refuse to run against a hidden window,
because a backgrounded tab pauses `requestAnimationFrame` and every measurement
becomes zero. They need a real GPU, so they run locally rather than in CI.
Run `test:pressure` before any change to the frame-pressure classifier.

## The one rule

**Never start a private `requestAnimationFrame` loop.** Subscribe to the shared
conductor. A second loop removes the coordination this package exists to
provide, and nothing errors when it happens — which is exactly why it has to be
a rule rather than a lint.

The probe page and the docs demos break this deliberately, to simulate an
uncooperative third-party library. Those are the only places it is correct, and
each says so in a comment.

## Other things worth knowing

- **No sourcemaps.** `tsup` embeds `sourcesContent`, which shipped ~112 KB of
  commented source inside the tarball. Deliberately off; don't re-enable.
- **`"use client"` is restored after the build.** esbuild strips module-level
  directives, so `scripts/preserve-directives.mjs` puts them back by parsing
  `tsup.config.ts`. Add an entry to the build and it is covered automatically.
- **Commit messages** follow Conventional Commits, and the body explains *why*,
  not what. Breaking changes carry `!` and a `BREAKING CHANGE:` paragraph with
  the migration.

## Reporting a bug

Open an issue with the version, the browser, and something runnable. A
StackBlitz or a repo beats a description — most of what goes wrong here is
timing, and timing does not survive prose.
