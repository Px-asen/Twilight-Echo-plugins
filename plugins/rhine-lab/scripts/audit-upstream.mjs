import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const upstream = resolve(root, "../../.cache/rhine-music-upstream");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function walk(dir, prefix = "") {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      files.push(...(await walk(join(dir, entry.name), relative + "/")));
    else files.push(relative);
  }
  return files.sort();
}
const report = {
  reference: "a889801f7f99993ee23b40e97efdeac6ad04a9be",
  generatedAt: new Date().toISOString(),
  unchanged: [],
  adapted: [],
  added: [],
  addedHashes: [],
  missing: [],
  assets: [],
};
const referenceFiles = await walk(join(upstream, "src"));
for (const file of referenceFiles) {
  const path = "src/" + file;
  const before = hash(await readFile(join(upstream, path)));
  let after;
  try {
    after = hash(await readFile(join(root, path)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    report.missing.push(path);
    continue;
  }
  report[before === after ? "unchanged" : "adapted"].push({
    file: path,
    upstream: before,
    current: after,
  });
}
for (const file of await walk(join(root, "src"))) {
  if (referenceFiles.includes(file)) continue;
  const path = "src/" + file;
  report.added.push(path);
  report.addedHashes.push({
    file: path,
    sha256: hash(await readFile(join(root, path))),
  });
}
for (const file of await walk(join(root, "public"))) {
  const path = "public/" + file;
  const current = await readFile(join(root, path));
  let matchesUpstream = false;
  try {
    matchesUpstream =
      hash(current) === hash(await readFile(join(upstream, path)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  report.assets.push({
    file: path,
    bytes: (await stat(join(root, path))).size,
    sha256: hash(current),
    matchesUpstream,
  });
}
await writeFile(
  join(root, "docs/UPSTREAM_AUDIT.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    unchanged: report.unchanged.length,
    adapted: report.adapted.length,
    added: report.added.length,
    missing: report.missing,
    assets: report.assets.length,
  }),
);
