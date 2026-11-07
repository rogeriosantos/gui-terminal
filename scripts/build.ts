import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const out = "dist";
await $`rm -rf ${out}`.quiet();
await $`mkdir -p ${out}/ui`.quiet();

// Bundle the React renderer with Bun (fast, no bundler config needed).
const renderer = await Bun.build({
  entrypoints: ["src/renderer/index.tsx"],
  outdir: `${out}/ui`,
  target: "browser",
  minify: true,
  naming: "[name]-[hash].[ext]",
  define: { APP_VERSION: JSON.stringify((await Bun.file("package.json").json()).version) },
  // xterm assets (css + wasm) come from node_modules; let the loader inline/file them
  publicPath: "ui/",
});
if (!renderer.success) {
  console.error(renderer.logs.join("\n"));
  process.exit(1);
}

// Find the emitted js + css to reference them from index.html.
const files = Array.from(new Bun.Glob(`${out}/ui/*`).scanSync("."));
const js = files.find((f) => f.endsWith(".js"))!;
const css = files.find((f) => f.endsWith(".css"));

const cssTag = css ? `<link rel="stylesheet" href="ui/${css.split("/").pop()}">` : "";
const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:">
    ${cssTag}
  </head>
  <body>
    <div id="root"></div>
    <script src="ui/${js.split("/").pop()}"></script>
  </body>
</html>
`;
await Bun.write(`${out}/index.html`, html);

// Compile the Electron main process (CommonJS output: Electron 39 supports ESM
// in the main process only with a .mjs extension and node-pty is CJS, so we
// keep main CJS for maximum compatibility).
await Bun.build({
  entrypoints: ["src/main/index.ts"],
  outdir: out,
  target: "node",
  format: "cjs",
  naming: "main.cjs",
  external: ["electron", "node-pty"],
});

// The preload script must be plain CJS with no imports bundled from node_modules.
await Bun.build({
  entrypoints: ["src/main/preload.ts"],
  outdir: out,
  target: "node",
  format: "cjs",
  naming: "preload.cjs",
  external: ["electron"],
});

console.log("build ok:", js, css ?? "(no css)");
