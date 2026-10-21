// vendor-types.ts
// node vendor-types.ts <entry1.d.ts> <out1.d.ts> [<entry2.d.ts> <out2.d.ts> ...]
// Requires typescript 5.x or 6.x resolvable from this file (7.x has no JS API).
import ts from "typescript";
import * as path from "node:path";
import * as fs from "node:fs";

// --- arguments -----------------------------------------------------------
const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  console.error("usage: node vendor-types.ts <entry.d.ts> <out.d.ts> [<entry.d.ts> <out.d.ts> ...]");
  process.exit(1);
}

const entries = new Map<string, string>(); // real input path -> output path
for (let i = 0; i < args.length; i += 2) {
  entries.set(fs.realpathSync(path.resolve(args[i])), path.resolve(args[i + 1]));
}
const outDir = path.dirname([...entries.values()][0]); // _deps lives beside the entries

const opts: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
};
const isDts = (f: string) => /\.d\.[cm]?ts$/.test(f);

// --- output path mapping -------------------------------------------------
const pkgCache = new Map<string, { root: string; id: string } | null>();
function findPkg(file: string) {
  let dir = path.dirname(file);
  while (true) {
    if (pkgCache.has(dir)) return pkgCache.get(dir)!;
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) {
      const { name, version } = JSON.parse(fs.readFileSync(pj, "utf8"));
      if (name) {
        const r = { root: dir, id: `${name}@${version ?? "0.0.0"}` };
        pkgCache.set(dir, r);
        return r;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function outPathFor(file: string) {
  const entryOut = entries.get(file);
  if (entryOut) return entryOut;
  const pkg = findPkg(file);
  if (!pkg) throw new Error(`No package.json found above ${file}`);
  return path.join(outDir, "_deps", pkg.id, path.relative(pkg.root, file));
}

function rel(fromOut: string, toOut: string) {
  let r = path.relative(path.dirname(fromOut), toOut).split(path.sep).join("/");
  if (!r.startsWith(".")) r = "./" + r;
  // .d.ts files are imported with their runtime extension
  return r
    .replace(/\.d\.ts$/, ".js")
    .replace(/\.d\.mts$/, ".mjs")
    .replace(/\.d\.cts$/, ".cjs");
}

// --- walk, rewrite, emit -------------------------------------------------
type Edit = { start: number; end: number; text: string };

function walk(file: string, seen: Set<string>, queue: string[]) {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const myOut = outPathFor(file);
  const edits: Edit[] = [];

  const target = (resolved: string | undefined) => {
    if (!resolved || !isDts(resolved)) return null;
    const real = fs.realpathSync(resolved);
    if (!seen.has(real)) {
      seen.add(real);
      queue.push(real);
    }
    return rel(myOut, outPathFor(real));
  };

  const handleSpec = (lit: ts.StringLiteralLike) => {
    const spec = lit.text;
    if (spec.startsWith("node:")) return; // leave built-ins alone
    const r = ts.resolveModuleName(spec, file, opts, ts.sys).resolvedModule;
    const newSpec = target(r?.resolvedFileName);
    if (newSpec) {
      edits.push({ start: lit.getStart(sf) + 1, end: lit.getEnd() - 1, text: newSpec });
    } else if (!r) {
      console.warn(`UNRESOLVED "${spec}" in ${file}`);
    }
  };

  const visit = (n: ts.Node) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      handleSpec(n.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteral(n.moduleReference.expression)
    ) {
      handleSpec(n.moduleReference.expression);
    } else if (
      ts.isImportTypeNode(n) &&
      ts.isLiteralTypeNode(n.argument) &&
      ts.isStringLiteral(n.argument.literal)
    ) {
      handleSpec(n.argument.literal);
    }
    ts.forEachChild(n, visit); // also descends into `declare module "x" { ... }`
  };
  visit(sf);

  // /// <reference path|types="..." />
  for (const m of text.matchAll(/\/\/\/\s*<reference\s+(path|types)\s*=\s*"([^"]+)"\s*\/>/g)) {
    const [whole, kind, val] = m;
    let resolved: string | undefined;
    if (kind === "path") {
      resolved = path.resolve(path.dirname(file), val);
    } else {
      resolved = ts.resolveTypeReferenceDirective(val, file, opts, ts.sys)
        .resolvedTypeReferenceDirective?.resolvedFileName;
    }
    const newPath = target(resolved);
    if (newPath) {
      edits.push({
        start: m.index!,
        end: m.index! + whole.length,
        // reference path wants the real file name, not the .js form
        text: `/// <reference path="${newPath
          .replace(/\.js$/, ".d.ts")
          .replace(/\.mjs$/, ".d.mts")
          .replace(/\.cjs$/, ".d.cts")}" />`,
      });
    }
  }

  // apply edits back to front so offsets stay valid
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  fs.mkdirSync(path.dirname(myOut), { recursive: true });
  fs.writeFileSync(myOut, out);

  // keep licenses alongside vendored third-party code
  const pkg = findPkg(file);
  if (pkg) {
    for (const f of fs.readdirSync(pkg.root)) {
      if (/^licen[cs]e/i.test(f)) {
        const dest = path.join(outDir, "_deps", pkg.id, f);
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(path.join(pkg.root, f), dest);
        }
      }
    }
  }
}

// --- main ----------------------------------------------------------------
const seen = new Set(entries.keys());
const queue = [...entries.keys()];
while (queue.length) walk(queue.shift()!, seen, queue);
console.log(`Vendored ${seen.size} declaration files into ${outDir}`);