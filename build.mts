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

const PREACT_VERSION = getVersion("preact");
const RXJS_VERSION = getVersion("rxjs");
const RX_VERSION = getVersion("@alshdavid/rx");

// prettier-ignore
const BUILD_MANIFEST = [
	{ packageName: "preact", output: "index.d.ts", entry: "dist/preact.mjs" },
	{ packageName: "preact", output: "compat.d.ts", entry: "compat/dist/compat.mjs" },
	{ packageName: "preact", output: "hooks.d.ts", entry: "hooks/dist/hooks.mjs" },
	{ packageName: "preact", output: "jsx-runtime.d.ts", entry: "jsx-runtime/dist/jsxRuntime.mjs" },
	{ packageName: "preact", output: "devtools.d.ts", entry: "devtools/dist/devtools.mjs" },
	{ packageName: "preact", output: "debug.d.ts", entry: "debug/dist/debug.mjs" },
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

// ---------------------------------------------------------------- preact

const PREACT_ALIASES: Record<string, string> = {
	preact: "./index.js",
	"preact/hooks": "./hooks.js",
	"preact/compat": "./compat.js",
	"preact/jsx-runtime": "./jsx-runtime.js",
	"preact/devtools": "./devtools.js",
	"preact/debug": "./debug.js",
};

// Rewrite bare `preact` specifiers left external by esbuild into relative paths
function rewritePreactImports(file: string) {
	const source = fs.readFileSync(file, "utf8");
	const rewritten = source.replace(
		/\b(from|import)\s*"(preact(?:\/[\w-]+)?)"/g,
		(match, keyword: string, specifier: string) => {
			const alias = PREACT_ALIASES[specifier];
			return alias ? `${keyword}"${alias}"` : match;
		},
	);
	fs.writeFileSync(file, rewritten);

	if (/\b(from|import)\s*"preact/.test(rewritten)) {
		throw new Error(`unrewritten preact import left in ${file}`);
	}
}

// Bundle one preact entry. preact itself stays external so hooks/compat/etc.
// share the single runtime in index.js, then bare specifiers become relative.
async function bundlePreactEntry(
	name: string,
	input: string,
	outDir: string,
) {
	const outfile = path.join(outDir, `${name}.js`);
	await bundle({ input, outfile, external: ["preact", "preact/*"] });
	rewritePreactImports(outfile);
}

async function buildPreact() {
	const preactDir = path.join(nodeModules, "preact");
	const outDir = path.join(vendorDir, `preact@${PREACT_VERSION}`);

	// Preact's own entry only needs bundling (nothing external to rewrite)
	await bundle({
		input: path.join(preactDir, "dist/preact.mjs"),
		outfile: path.join(outDir, "index.js"),
	});

	await bundlePreactEntry("compat", path.join(preactDir, "compat/dist/compat.mjs"), outDir);
	await bundlePreactEntry("hooks", path.join(preactDir, "hooks/dist/hooks.mjs"), outDir);
	await bundlePreactEntry("jsx-runtime", path.join(preactDir, "jsx-runtime/dist/jsxRuntime.mjs"), outDir);
	await bundlePreactEntry("devtools", path.join(preactDir, "devtools/dist/devtools.mjs"), outDir);
	await bundlePreactEntry("debug", path.join(preactDir, "debug/dist/debug.mjs"), outDir);

	// All preact entrypoints in ONE run so they share a single copy of the types
	vendorTypesFor([
		[typesOf("preact"), path.join(outDir, "index.d.ts")],
		[typesOf("preact/compat"), path.join(outDir, "compat.d.ts")],
		[typesOf("preact/hooks"), path.join(outDir, "hooks.d.ts")],
		[typesOf("preact/jsx-runtime"), path.join(outDir, "jsx-runtime.d.ts")],
		[typesOf("preact/devtools"), path.join(outDir, "devtools.d.ts")],
		[typesOf("preact/debug"), path.join(outDir, "debug.d.ts")],
	]);
}

// ---------------------------------------------------------------- rxjs

async function buildRxjs() {
	const outDir = path.join(vendorDir, `rxjs@${RXJS_VERSION}`);

	await bundle({
		input: path.join(nodeModules, "rxjs/dist/esm5/index.js"),
		outfile: path.join(outDir, "index.js"),
	});
	vendorTypesFor([[typesOf("rxjs"), path.join(outDir, "index.d.ts")]]);
}

// ---------------------------------------------------------------- @alshdavid/rx

async function buildRx() {
	const outDir = path.join(vendorDir, `rx@${RX_VERSION}`);

	await bundle({
		input: path.join(nodeModules, "@alshdavid/rx/dist/index.js"),
		outfile: path.join(outDir, "index.js"),
	});
	vendorTypesFor([[typesOf("@alshdavid/rx"), path.join(outDir, "index.d.ts")]]);
}

// ---------------------------------------------------------------- main

async function main() {
	assertTypescriptJsApi();

	fs.rmSync(vendorDir, { recursive: true, force: true });

	await buildPreact();
	await buildRxjs();
	await buildRx();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
