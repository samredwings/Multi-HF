import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "dist");
const required = ["index.html", "manifest.webmanifest", "favicon.svg", "src/app.js", "src/lib/core.js", "src/styles.css", "service-worker.js"];
for (const rel of required) {
  const file = resolve(root, rel);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`Required build file missing: ${rel}`);
  if (rel.endsWith(".js")) await readFile(file, "utf8");
}
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const rel of ["index.html", "manifest.webmanifest", "favicon.svg", "service-worker.js", "src"]) {
  await cp(resolve(root, rel), resolve(out, rel), { recursive: true });
}
console.log(`Built static app to ${out}`);
