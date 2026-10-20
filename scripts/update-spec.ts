// Re-downloads Deye's Swagger spec and reports added/removed/changed endpoints.
//   npm run update-spec          (dry run: shows the diff)
//   npm run update-spec -- --write
import fs from "node:fs";

const FILE = "docs/deye-openapi.json";
const URL = `${process.env.DEYE_BASE_URL || "https://eu1-developer.deyecloud.com"}/v2/api-docs`;

type Spec = { paths: Record<string, Record<string, { summary?: string; description?: string }>> };

const raw = await (await fetch(URL)).text();
// Deye's spec contains an unquoted example (`"example":[12583SS]`) that breaks JSON parsing; quote it.
const fixed = raw.replace(/("example":)\[(\w*[A-Za-z]\w*)\]/g, '$1["$2"]');
const next = JSON.parse(fixed) as Spec;
const prev = JSON.parse(fs.readFileSync(FILE, "utf8")) as Spec;

const ops = (s: Spec) =>
  new Map(Object.entries(s.paths).flatMap(([p, o]) => Object.entries(o).map(([m, op]) => [`${m.toUpperCase()} ${p}`, JSON.stringify(op)] as const)));
const a = ops(prev);
const b = ops(next);
const added = [...b.keys()].filter((k) => !a.has(k));
const removed = [...a.keys()].filter((k) => !b.has(k));
const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k));

console.log(`Fetched ${URL}: ${b.size} operations (was ${a.size})`);
for (const [label, list] of [["+ added", added], ["- removed", removed], ["~ changed", changed]] as const) for (const k of list) console.log(`${label}  ${k}`);
if (!added.length && !removed.length && !changed.length) console.log("No changes.");

if (process.argv.includes("--write")) {
  fs.writeFileSync(FILE, JSON.stringify(next, null, 1));
  console.log(`Wrote ${FILE}. Review docs/annotations.ts for new endpoints.`);
}
