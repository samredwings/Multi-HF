import { cp, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const run = (command, args) => {
  // Keep shell execution disabled: process.execPath may contain spaces on Windows,
  // and spawnSync already handles executable paths without shell quoting.
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed.`);
};
run(process.execPath, ["scripts/build.mjs"]);
const dist = resolve(root, "dist");
// MainActivity maps the Android asset root to https://appassets.androidplatform.net/,
// so copy index.html, src/, and the PWA files directly into assets/.
const assets = resolve(root, "android/app/src/main/assets");
await stat(resolve(dist, "index.html"));
await rm(assets, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
await cp(dist, assets, { recursive: true });
console.log(`Prepared Android WebView assets at ${assets}`);
