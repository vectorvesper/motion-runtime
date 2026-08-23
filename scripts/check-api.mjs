/**
 * Public API guard — the photo of the menu taped to the wall.
 *
 *   node scripts/check-api.mjs           # fail if the built surface drifted
 *   node scripts/check-api.mjs --update  # accept the current surface as the new truth
 *
 * Every exported name is a support commitment, and so is every field on an
 * exported type. This reads the built .d.ts for each published entry and diffs
 * both against the committed api-surface.json: the list of exported names, and
 * the shape of each one.
 *
 * Wired into prepublishOnly, so a drifted surface cannot be published.
 *
 * ## Why shapes, not just names
 *
 * The name-only version missed an entire class of breaking change. On
 * 2026-08-23 a pass over the hook options renamed or replaced fields on seven
 * exported types — `minHeadroomMs` and `requiredCleanFrames` off
 * UseSafeToMountOptions, `smooth` to `speed` on VideoScrubberOptions, five
 * fields off PointerIntentOptions — and every one of them was invisible here,
 * because no exported *name* changed. A customer upgrading would have got a
 * broken build that this script had just called clean.
 *
 * Comments are deliberately excluded. Rewording a doc comment is not an API
 * change, and a guard that cries wolf on prose gets run with --update
 * reflexively, which is how a real change slips through.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "..");
const SNAPSHOT = path.join(ROOT, "api-surface.json");

/** The published entry points, by their package export path. */
const ENTRIES = {
  ".": "dist/index.d.ts",
  "./react": "dist/react.d.ts",
  "./devtools": "dist/devtools.d.ts",
};

const norm = (s) => s.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();

/**
 * A structural description of one declaration, with comments stripped.
 *
 * Members are read one at a time rather than taking the whole node's text,
 * because a member's JSDoc is inside its parent's span but outside its own.
 */
function describe(node, sf) {
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
    const heritage = (node.heritageClauses ?? [])
      .map((h) => norm(h.getText(sf)))
      .join(" ");
    const members = node.members
      .filter((m) => {
        const mods = ts.getModifiers?.(m) ?? m.modifiers ?? [];
        return !mods.some(
          (x) =>
            x.kind === ts.SyntaxKind.PrivateKeyword ||
            x.kind === ts.SyntaxKind.ProtectedKeyword,
        );
      })
      .map((m) => norm(m.getText(sf)))
      .filter((t) => !t.startsWith("#"))
      .sort();
    return { kind: "object", heritage, members };
  }

  if (ts.isTypeAliasDeclaration(node)) {
    return { kind: "alias", type: norm(node.type.getText(sf)) };
  }

  if (ts.isFunctionDeclaration(node)) {
    const params = node.parameters.map((p) => norm(p.getText(sf)));
    const ret = node.type ? norm(node.type.getText(sf)) : "unknown";
    const generics = (node.typeParameters ?? []).map((t) => norm(t.getText(sf)));
    return { kind: "function", generics, params, returns: ret };
  }

  if (ts.isVariableDeclaration(node)) {
    return {
      kind: "value",
      type: node.type ? norm(node.type.getText(sf)) : "inferred",
    };
  }

  if (ts.isEnumDeclaration(node)) {
    return { kind: "enum", members: node.members.map((m) => norm(m.getText(sf))).sort() };
  }

  return { kind: "other", text: norm(node.getText(sf)) };
}

/**
 * Parsed .d.ts files, by absolute path.
 *
 * The entries are not self-contained. tsup emits the core entry as a pure
 * re-export barrel (`export { j as damp } from './chunk.js'`), and the react
 * entry imports from the same chunk under an alias and re-binds it
 * (`declare const damp: typeof damp$1`). Reading one file in isolation, which
 * is what the first version of this script did, yields "unresolved" for every
 * name that matters.
 */
const files = new Map();

function load(abs) {
  if (files.has(abs)) return files.get(abs);
  if (!fs.existsSync(abs)) {
    files.set(abs, null);
    return null;
  }
  const sf = ts.createSourceFile(
    abs,
    fs.readFileSync(abs, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const decls = new Map(); // local name -> declaration node
  const imports = new Map(); // local name -> { file, exported }
  const exports = new Map(); // exported name -> { local, file | null }

  const resolveSpecifier = (node) => {
    const spec = node.moduleSpecifier?.text;
    if (!spec) return null;
    return path.resolve(path.dirname(abs), spec.replace(/\.js$/, ".d.ts"));
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const from = resolveSpecifier(stmt);
      const clause = stmt.importClause;
      if (!from || !clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
      for (const el of clause.namedBindings.elements) {
        imports.set(el.name.text, { file: from, exported: (el.propertyName ?? el.name).text });
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
      const from = resolveSpecifier(stmt);
      for (const el of stmt.exportClause.elements) {
        exports.set(el.name.text, {
          local: (el.propertyName ?? el.name).text,
          file: from,
          isType: stmt.isTypeOnly || el.isTypeOnly,
        });
      }
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (d.name && ts.isIdentifier(d.name)) decls.set(d.name.text, d);
      }
      continue;
    }
    if (stmt.name && ts.isIdentifier(stmt.name)) decls.set(stmt.name.text, stmt);
  }

  const parsed = { sf, decls, imports, exports };
  files.set(abs, parsed);
  return parsed;
}

/** Shape of a name as that file exports it, following re-exports. */
function shapeOfExport(abs, name, seen = new Set()) {
  const key = abs + "::export::" + name;
  if (seen.has(key)) return { kind: "cycle" };
  seen.add(key);

  const f = load(abs);
  if (!f) return { kind: "unresolved" };
  const spec = f.exports.get(name);
  if (!spec) return shapeOfLocal(abs, name, seen);
  if (spec.file) return shapeOfExport(spec.file, spec.local, seen);
  return shapeOfLocal(abs, spec.local, seen);
}

/** Shape of a local binding, following imports and `typeof` re-bindings. */
function shapeOfLocal(abs, name, seen = new Set()) {
  const key = abs + "::local::" + name;
  if (seen.has(key)) return { kind: "cycle" };
  seen.add(key);

  const f = load(abs);
  if (!f) return { kind: "unresolved" };

  const decl = f.decls.get(name);
  if (decl) {
    // `declare const damp: typeof damp$1` — the shape lives wherever damp$1 does.
    if (
      ts.isVariableDeclaration(decl) &&
      decl.type &&
      ts.isTypeQueryNode(decl.type) &&
      ts.isIdentifier(decl.type.exprName)
    ) {
      return shapeOfLocal(abs, decl.type.exprName.text, seen);
    }
    return describe(decl, f.sf);
  }

  const imported = f.imports.get(name);
  if (imported) return shapeOfExport(imported.file, imported.exported, seen);

  return { kind: "unresolved" };
}

/** Exported names plus the shape of each, from one built entry .d.ts. */
function readSurface(file) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.error(`✗ ${file} not built. Run \`npm run build\` first.`);
    process.exit(1);
  }
  const f = load(abs);

  const values = new Set();
  const types = new Set();
  const shapes = {};

  for (const [exported, spec] of f.exports) {
    (spec.isType ? types : values).add(exported);
    shapes[exported] = shapeOfExport(abs, exported);
  }

  const unresolved = Object.entries(shapes)
    .filter(([, v]) => v.kind === "unresolved")
    .map(([k]) => k);
  if (unresolved.length) {
    console.error(
      `✗ ${file}: could not resolve ${unresolved.length} export(s): ${unresolved.join(", ")}.` +
        `
  The guard cannot vouch for a shape it could not read. Fix the resolver` +
        `
  rather than accepting the snapshot.`,
    );
    process.exit(1);
  }

  return { values: [...values].sort(), types: [...types].sort(), shapes };
}

const current = {};
for (const [entry, file] of Object.entries(ENTRIES)) current[entry] = readSurface(file);

if (process.argv.includes("--update")) {
  fs.writeFileSync(SNAPSHOT, JSON.stringify(current, null, 2) + "\n");
  console.log("✓ api-surface.json updated to the current built surface.");
  process.exit(0);
}

if (!fs.existsSync(SNAPSHOT)) {
  console.error("✗ No api-surface.json. Create it with: node scripts/check-api.mjs --update");
  process.exit(1);
}

const saved = JSON.parse(fs.readFileSync(SNAPSHOT, "utf-8"));
const nameProblems = [];
const shapeProblems = [];

for (const entry of Object.keys(ENTRIES)) {
  for (const kind of ["values", "types"]) {
    const was = new Set(saved[entry]?.[kind] ?? []);
    const now = new Set(current[entry][kind]);
    for (const name of now)
      if (!was.has(name)) nameProblems.push(`+ ${entry} added ${kind.slice(0, -1)}: ${name}`);
    for (const name of was)
      if (!now.has(name)) nameProblems.push(`- ${entry} removed ${kind.slice(0, -1)}: ${name}`);
  }

  const savedShapes = saved[entry]?.shapes;
  // No shapes in the snapshot means it predates this check. Say so rather than
  // reporting every export as changed.
  if (!savedShapes) {
    console.error(
      `✗ ${entry}: api-surface.json has no shape data. It was written by an older` +
        `\n  version of this script. Re-run with --update after reviewing the diff.`,
    );
    process.exit(1);
  }

  for (const [name, shape] of Object.entries(current[entry].shapes)) {
    const before = savedShapes[name];
    if (!before) continue; // a new export; already reported by name
    const a = JSON.stringify(before);
    const b = JSON.stringify(shape);
    if (a === b) continue;

    shapeProblems.push(`~ ${entry} ${name} changed shape`);
    if (before.kind === "object" && shape.kind === "object") {
      const was = new Set(before.members);
      const now = new Set(shape.members);
      for (const m of shape.members) if (!was.has(m)) shapeProblems.push(`      + ${m}`);
      for (const m of before.members) if (!now.has(m)) shapeProblems.push(`      - ${m}`);
      if (before.heritage !== shape.heritage) {
        shapeProblems.push(`      extends: ${before.heritage || "(none)"} → ${shape.heritage || "(none)"}`);
      }
    } else {
      shapeProblems.push(`      was: ${a}`);
      shapeProblems.push(`      now: ${b}`);
    }
  }
}

if (nameProblems.length || shapeProblems.length) {
  console.error("✗ Public API surface changed:\n");
  for (const p of nameProblems) console.error("  " + p);
  if (nameProblems.length && shapeProblems.length) console.error("");
  for (const p of shapeProblems) console.error("  " + p);
  console.error(
    "\nRemoving an export, or a field from an exported type, is a BREAKING change" +
      "\n(major bump). Adding one is a new commitment. If this is intentional," +
      "\nre-run with --update and bump the version accordingly.",
  );
  process.exit(1);
}

console.log("✓ Public API surface matches api-surface.json — names and shapes.");
