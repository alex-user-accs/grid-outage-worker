// Pre-commit guard: refuse to commit secrets or runtime data.
import { execSync } from "node:child_process";

const staged = execSync("git diff --cached --name-only", { encoding: "utf8" }).split("\n").filter(Boolean);
const bad = staged.filter((f) => /(^|\/)\.env($|\.(?!example$))/.test(f) || f.startsWith("data/") || f.startsWith("tests/fixtures/live/") || /\.db(-wal|-shm)?$/.test(f));
if (bad.length) {
  console.error(`✗ Refusing to commit secrets/runtime data:\n  ${bad.join("\n  ")}\nUnstage them with: git restore --staged <file>`);
  process.exit(1);
}
