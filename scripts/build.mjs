import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(full)); else out.push(full);
  }
  return out.sort();
}
const hash = createHash("sha256");
for (const file of await files(out)) if (!file.endsWith("service-worker.js")) hash.update(await readFile(file));
const swPath = resolve(out, "service-worker.js");
await writeFile(swPath, (await readFile(swPath, "utf8")).replaceAll("__BUILD__", hash.digest("hex").slice(0, 12)));
console.log(`Built static app to ${out}`);
