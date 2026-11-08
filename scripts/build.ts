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

// electron-builder's cross-arch runs rebuild node-pty in place for the TARGET
// arch, clobbering the host-arch binary. Restore the host build whenever the
// installed one does not match this machine.
const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const ptyNode = "node_modules/node-pty/build/Release/pty.node";
if (await Bun.file(ptyNode).exists()) {
  // Mach-O CPU type at offset 4: arm64 = 0x0100000C, x86_64 = 0x01000007.
  const bytes = new Uint8Array(await Bun.file(ptyNode).slice(4, 8).arrayBuffer());
  const cpuType = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  const fileArch = cpuType === 0x0100000c ? "arm64" : cpuType === 0x01000007 ? "x64" : "other";
  if (fileArch !== hostArch) {
    console.log(`node-pty is ${fileArch}, rebuilding for ${hostArch} (host)...`);
    const proc = Bun.spawnSync({
      cmd: [
        "sh", "-c",
        "cd node_modules/node-pty && npx node-gyp rebuild --runtime=electron --target=39.8.10 --dist-url=https://electronjs.org/headers",
      ],
      stdout: "inherit",
      stderr: "inherit",
    });
    if (proc.exitCode !== 0) process.exit(1);
  }
}

console.log("build ok:", js, css ?? "(no css)");
