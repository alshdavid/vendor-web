#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

NM="$REPO_ROOT/node_modules"
ESBUILD="$NM/esbuild/bin/esbuild"
VENDOR="$REPO_ROOT/vendor"

rm -rf vendor

# vendor-types.ts needs the JS compiler API (TypeScript 5.x/6.x, not 7.x)
node -e 'try{const ts=require("typescript");if(typeof ts.createSourceFile!=="function")throw 0}catch{console.error("vendor-types.ts needs typescript 5.x/6.x with the JS API (not 7.x)");process.exit(1)}'

# Resolve the .d.ts a specifier points at, using the package's own exports/types fields
types_of() {
  node -e '
    const ts = require("typescript");
    const r = ts.resolveModuleName(process.argv[1], process.argv[2] + "/x.ts", {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
    }, ts.sys).resolvedModule;
    if (!r || !/\.d\.[cm]?ts$/.test(r.resolvedFileName)) {
      console.error("no types found for " + process.argv[1]); process.exit(1);
    }
    console.log(require("fs").realpathSync(r.resolvedFileName));
  ' "$1" "$REPO_ROOT"
}

# ---------------------------------------------------------------- preact
PREACT="$NM/preact"
OUT="$VENDOR/preact@11.0.1"

# Bundle one preact entry. preact itself stays external so hooks/compat/etc.
# share the single runtime in index.js, then bare specifiers become relative.
bundle_preact() { # <name> <input>
  "$ESBUILD" --bundle "$2" --format=esm --minify \
    --external:preact --external:'preact/*' --outfile="$OUT/$1.js"
  perl -pi -e '
    BEGIN { %m = (
      "preact"             => "./index.js",
      "preact/hooks"       => "./hooks.js",
      "preact/compat"      => "./compat.js",
      "preact/jsx-runtime" => "./jsx-runtime.js",
      "preact/devtools"    => "./devtools.js",
      "preact/debug"       => "./debug.js",
    ) }
    s#\b(from|import)\s*"(preact(?:/[\w-]+)?)"#exists $m{$2} ? "$1\"$m{$2}\"" : $&#ge
  ' "$OUT/$1.js"
  if grep -Eq '(from|import)\s*"preact' "$OUT/$1.js"; then
    echo "unrewritten preact import left in $OUT/$1.js" >&2; exit 1
  fi
}

# Preact's own entry only needs bundling (nothing external to rewrite)
"$ESBUILD" --bundle "$PREACT/dist/preact.mjs" --format=esm --minify --outfile="$OUT/index.js"
bundle_preact compat      "$PREACT/compat/dist/compat.mjs"
bundle_preact hooks       "$PREACT/hooks/dist/hooks.mjs"
bundle_preact jsx-runtime "$PREACT/jsx-runtime/dist/jsxRuntime.mjs"
bundle_preact devtools    "$PREACT/devtools/dist/devtools.mjs"
bundle_preact debug       "$PREACT/debug/dist/debug.mjs"

# All preact entrypoints in ONE run so they share a single copy of the types
node "$REPO_ROOT/vendor-types.ts" \
  "$(types_of preact)"            "$OUT/index.d.ts" \
  "$(types_of preact/compat)"     "$OUT/compat.d.ts" \
  "$(types_of preact/hooks)"      "$OUT/hooks.d.ts" \
  "$(types_of preact/jsx-runtime)" "$OUT/jsx-runtime.d.ts" \
  "$(types_of preact/devtools)"   "$OUT/devtools.d.ts" \
  "$(types_of preact/debug)"      "$OUT/debug.d.ts"

# ---------------------------------------------------------------- rxjs
OUT="$VENDOR/rxjs@7.8.2"
"$ESBUILD" --bundle "$NM/rxjs/dist/esm5/index.js" --format=esm --minify --outfile="$OUT/index.js"
node "$REPO_ROOT/vendor-types.ts" "$(types_of rxjs)" "$OUT/index.d.ts"

# ---------------------------------------------------------------- @alshdavid/rx
OUT="$VENDOR/rx@0.0.3"
"$ESBUILD" --bundle "$NM/@alshdavid/rx/dist/index.js" --format=esm --minify --outfile="$OUT/index.js"
node "$REPO_ROOT/vendor-types.ts" "$(types_of @alshdavid/rx)" "$OUT/index.d.ts"