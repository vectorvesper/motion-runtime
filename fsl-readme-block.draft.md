# Draft — README licence changes for 3.0

Not wired in. Three edits when you decide to go ahead.

---

## 1. The badge (README.md line 11)

Replace:

```md
[![license](https://img.shields.io/badge/license-MIT-a3a3a3)](./LICENSE)
```

with:

```md
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-a3a3a3)](./LICENSE)
```

---

## 2. The plain-English block

Goes near the top, right after the badges — before anyone scrolls. This is the
part that decides how the licence lands. A reader should be able to tell in ten
seconds whether they are allowed to use this.

```md
## Licence, in plain English

[FSL-1.1-MIT](./LICENSE). Use it for almost anything. **On 2028-XX-XX it becomes
MIT**, permanently.

- ✅ **Use it in your product**, commercial or not, closed or open source.
- ✅ **Use it in client work.** Agencies and freelancers, this is you.
- ✅ **Fork it, change it, ship your changes.**
- ❌ **Don't repackage it as a competing motion runtime** and sell that.

That last line is the only restriction. If you are building a website, an app,
or something for a client, you are fine — you do not need to think about this
any further.

Two years after each release, that restriction expires and the code is MIT.
The clock is per version, so it is always running.
```

Set the date to two years from the day you publish 3.0.

---

## 3. The footer (README.md line 173)

Replace:

```md
[MIT](./LICENSE) © Vector Vesper
```

with:

```md
[FSL-1.1-MIT](./LICENSE) © Vector Vesper — becomes MIT two years after each release.
```

---

## Also needs doing at 3.0

- **`package.json`.** FSL is not OSI-approved and I could not confirm it is in
  the SPDX register, so `"license": "FSL-1.1-MIT"` may warn on `npm publish`.
  The safe form is `"license": "SEE LICENSE IN LICENSE"`. Worth running
  `npm publish --dry-run` to see which npm accepts before committing to it.
- **`LICENSE`.** Replace the MIT text with `LICENSE.fsl-draft.md`, then delete
  the draft.
- **CHANGELOG.** A short 3.0 note saying the licence changed, that 2.x remains
  MIT forever, and why.
- **vv-site `/license` page.** Check whether it states MIT for the runtime.
- **CONTRIBUTING.md.** Currently says "It is MIT and published as
  @vectorvesper/motion" — that sentence needs updating.

## One thing to be clear about with yourself

Everything published up to 2.0.1 stays MIT permanently. That grant cannot be
withdrawn. Anyone who wants the MIT version can fork 2.0.1 and continue from
there — with today's adoption that is theoretical, but it is the real boundary
of what relicensing buys you. FSL protects 3.0 onward, not the past.
