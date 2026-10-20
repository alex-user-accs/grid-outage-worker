// Usage: npm run hash-password -- deye   → SHA-256 hex for DEYE_PASSWORD_SHA256
//        npm run hash-password -- admin  → argon2 hash for ADMIN_PASSWORD_HASH
// The password is read from the terminal without echo and is never written anywhere.
import { hash } from "@node-rs/argon2";
import { createHash } from "node:crypto";

const mode = process.argv[2];
if (mode !== "deye" && mode !== "admin") {
  console.error("Usage: npm run hash-password -- <deye|admin>");
  process.exit(1);
}

async function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Piped input: read the first line.
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.split(/\r?\n/)[0];
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (ch: string) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(value);
      } else if (ch === "\u0003") {
        process.exit(130);
      } else if (ch === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const pw = await readHidden(mode === "deye" ? "Deye account password: " : "New dashboard password: ");
if (!pw) {
  console.error("Empty password.");
  process.exit(1);
}
if (mode === "deye") {
  console.log(`\nDEYE_PASSWORD_SHA256=${createHash("sha256").update(pw, "utf8").digest("hex")}`);
} else {
  if (pw.length < 10) console.warn("Warning: use at least 10 characters.");
  // Next.js expands $VAR in .env even inside quotes, so every $ must be escaped as \$.
  console.log(`\nADMIN_PASSWORD_HASH=${(await hash(pw)).replaceAll("$", "\\$")}`);
}
