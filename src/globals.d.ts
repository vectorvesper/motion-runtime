/**
 * Build-time substitutions. tsup's `define` replaces `__VV_VERSION__` with the
 * version from package.json, so it is declared and never imported.
 */

declare const __VV_VERSION__: string;
