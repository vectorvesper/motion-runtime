/**
 * Build-time substitutions.
 *
 * `__VV_VERSION__` is replaced by tsup's `define` with the version from
 * package.json. It never exists at runtime — by the time the bundle is written
 * it has already become a string literal — so it is declared, never imported.
 */

declare const __VV_VERSION__: string;
