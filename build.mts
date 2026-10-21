// build.mts
// Vendors preact, rxjs and @alshdavid/rx into ./vendor with bundled JS and
// rewritten declaration files. Run with: node build.mts
import * as esbuild from "esbuild";
import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { vendorTypes } from "./lib/vendor-types.mts";
import { getVersion } from "./lib/get-version.mts";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
}).trim();

const nodeModules = path.join(repoRoot, "node_modules");
const vendorDir = path.join(repoRoot, "vendor");

interface BuildManifestEntry {
	/** Package to vendor, e.g. "preact" */
	packageName: string;
	/** Declaration file to emit into the package's vendor folder, e.g. "compat.d.ts" */
	output: string;
	/** JavaScript entry point, relative to the package root */
	entry: string;
}

// prettier-ignore
const BUILD_MANIFEST: BuildManifestEntry[] = [
	// Preact
	{ packageName: "preact", 		output: "index.d.ts", 		entry: "dist/preact.mjs" 					},
	{ packageName: "preact", 		output: "compat.d.ts", 		entry: "compat/dist/compat.mjs" 			},
	{ packageName: "preact", 		output: "hooks.d.ts", 		entry: "hooks/dist/hooks.mjs" 				},
	{ packageName: "preact", 		output: "jsx-runtime.d.ts", entry: "jsx-runtime/dist/jsxRuntime.mjs" 	},
	{ packageName: "preact", 		output: "devtools.d.ts", 	entry: "devtools/dist/devtools.mjs" 		},
	{ packageName: "preact", 		output: "debug.d.ts", 		entry: "debug/dist/debug.mjs" 				},

	// Rxjs
	{ packageName: "rxjs", 			output: "index.d.ts", 		entry: "dist/esm5/index.js" 				},

	// @alshdavid/rx
	{ packageName: "@alshdavid/rx",	output: "index.d.ts", 		entry: "dist/index.js" 						},
]

// ---------------------------------------------------------------- helpers

// lib/vendor-types.mts needs the JS compiler API (TypeScript 5.x/6.x, not 7.x)
function assertTypescriptJsApi() {
	if (typeof (ts as unknown as { createSourceFile?: unknown }).createSourceFile !== "function") {
		throw new Error(
			"lib/vendor-types.mts needs typescript 5.x/6.x with the JS API (not 7.x)",
		);
	}
}

// Resolve the .d.ts a specifier points at, using the package's own exports/types fields
function typesOf(specifier: string): string {
	const resolved = ts.resolveModuleName(
		specifier,
		path.join(repoRoot, "x.ts"),
		{
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			module: ts.ModuleKind.ESNext,
		},
		ts.sys,
	).resolvedModule;

	if (!resolved || !/\.d\.[cm]?ts$/.test(resolved.resolvedFileName)) {
		throw new Error(`no types found for ${specifier}`);
	}

	return fs.realpathSync(resolved.resolvedFileName);
}

async function bundle(options: {
	input: string;
	outfile: string;
	external?: string[];
}) {
	await esbuild.build({
		entryPoints: [options.input],
		bundle: true,
		format: "esm",
		minify: true,
		external: options.external,
		outfile: options.outfile,
		// Don't pick up (or fail on) a workspace tsconfig.json
		tsconfigRaw: {},
	});
}

function vendorTypesFor(entries: Array<[input: string, outfile: string]>) {
	const { outDir, fileCount } = vendorTypes(entries);
	console.log(`Vendored ${fileCount} declaration files into ${outDir}`);
}

// The manifest's output name identifies the export subpath (e.g. "compat.d.ts"
// is the "<package>/compat" export, while "index.d.ts" is the package root)
function exportSpecifier(packageName: string, output: string) {
	const subpath = path.basename(output).replace(/\.d\.[cm]?ts$/, "");
	return subpath === "index" ? packageName : `${packageName}/${subpath}`;
}

function jsOutputName(output: string) {
	return path
		.basename(output)
		.replace(/\.d\.ts$/, ".js")
		.replace(/\.d\.mts$/, ".mjs")
		.replace(/\.d\.cts$/, ".cjs");
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rewrite bare package specifiers left external by esbuild into relative paths
function rewriteSelfImports(
	file: string,
	packageName: string,
	aliases: Map<string, string>,
) {
	const source = fs.readFileSync(file, "utf8");
	const pattern = new RegExp(
		`\\b(from|import)\\s*"(${escapeRegExp(packageName)}(?:/[\\w.-]+)?)"`,
		"g",
	);
	const rewritten = source.replace(
		pattern,
		(match, keyword: string, specifier: string) => {
			const alias = aliases.get(specifier);
			return alias ? `${keyword}"${alias}"` : match;
		},
	);
	fs.writeFileSync(file, rewritten);

	if (
		new RegExp(
			`\\b(from|import)\\s*"${escapeRegExp(packageName)}(?:/|")`,
		).test(rewritten)
	) {
		throw new Error(`unrewritten ${packageName} import left in ${file}`);
	}
}

// Vendors one package's entrypoints. The package itself stays external while
// bundling so hooks/compat/etc. share a single runtime, then those specifiers
// are rewritten into relative paths and all type entries are emitted in one
// pass so they share a single `_deps` copy.
async function buildPackage(
	packageName: string,
	entries: BuildManifestEntry[],
) {
	const version = getVersion(packageName);
	// Keep scopes as folders: "@alshdavid/rx@1.2.3" -> vendor/@alshdavid/rx@1.2.3
	const outDir = path.join(vendorDir, `${packageName}@${version}`);

	const aliases = new Map(
		entries.map((entry) => [
			exportSpecifier(packageName, entry.output),
			`./${jsOutputName(entry.output)}`,
		]),
	);

	const typeEntries: Array<[input: string, outfile: string]> = [];

	for (const entry of entries) {
		const outfile = path.join(outDir, jsOutputName(entry.output));
		await bundle({
			input: path.join(nodeModules, packageName, entry.entry),
			outfile,
			external: [packageName, `${packageName}/*`],
		});
		rewriteSelfImports(outfile, packageName, aliases);

		typeEntries.push([
			typesOf(exportSpecifier(packageName, entry.output)),
			path.join(outDir, entry.output),
		]);
	}

	vendorTypesFor(typeEntries);
}

// ---------------------------------------------------------------- main

async function main() {
	assertTypescriptJsApi();

	fs.rmSync(vendorDir, { recursive: true, force: true });

	// Group manifest rows by package so each package is vendored in one pass
	const packages = new Map<string, BuildManifestEntry[]>();
	for (const entry of BUILD_MANIFEST) {
		const entries = packages.get(entry.packageName);
		if (entries) entries.push(entry);
		else packages.set(entry.packageName, [entry]);
	}

	for (const [packageName, entries] of packages) {
		await buildPackage(packageName, entries);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
