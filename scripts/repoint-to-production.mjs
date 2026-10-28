/**
 * Repoint the app at the Neon `production` branch and seed it.
 *
 * VASRUE Digital Media — Clinton Douglas IV. Contract #2942026-1353.
 *
 * RUN THIS ONLY AFTER scripts/migrate-production.mjs HAS SUCCEEDED.
 * It refuses to run otherwise, and that refusal is the point: repointing
 * DATABASE_URL at an unmigrated database would take a working application
 * and silently give it an empty one.
 *
 * WHAT IT DOES, IN ORDER
 *   1. Resolves the production connection string and verifies the host.
 *   2. Verifies production's schema already matches prisma/schema.prisma.
 *      A non-zero gap aborts — migrate first.
 *   3. Backs up .env, then rewrites only its DATABASE_URL line and the
 *      branch comment above it. Every other value is left untouched.
 *   4. Runs prisma/seed.ts against production.
 *   5. Re-verifies, and confirms all migrations are recorded as applied.
 *
 * The seed is safe to run more than once: 9 upserts, one createMany with
 * skipDuplicates, and one create guarded by an existence check. Nothing in
 * it deletes or overwrites.
 *
 * SAME TWO CAUTIONS AS THE MIGRATION SCRIPT, FOR THE SAME REASONS
 *   - No shell is ever spawned for a command holding the connection string.
 *     A Neon URL ends `?sslmode=require&channel_binding=require`, and through
 *     a Windows shell that `&` is a command separator that silently discards
 *     the rest of the command line.
 *   - Every output path, including thrown error text, goes through redact().
 *     execFileSync puts the whole command line into its error message, so an
 *     unredacted failure prints the database password.
 *
 * Run with:
 *   node scripts/repoint-to-production.mjs            # repoint and seed
 *   node scripts/repoint-to-production.mjs --check    # report only
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");

/** The production branch's compute host, confirmed against the Neon API. */
const EXPECTED_HOST_PREFIX = "ep-cold-salad-";
const BRANCH = "production";
const ENV_FILE = path.join(ROOT, ".env");

const PRISMA_CLI = path.join(ROOT, "node_modules", "prisma", "build", "index.js");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

for (const [label, cli] of [["Prisma", PRISMA_CLI], ["tsx", TSX_CLI]]) {
  if (!fs.existsSync(cli)) {
    console.error(`Cannot find the ${label} CLI at ${cli}. Run npm ci first.`);
    process.exit(1);
  }
}

/** Everything printed goes through this. See the header. */
let SECRETS = [];
function redact(text) {
  let s = String(text ?? "");
  for (const secret of SECRETS) {
    if (secret) s = s.split(secret).join("[REDACTED]");
  }
  return s;
}

function fail(message) {
  console.error("");
  console.error("ABORTED: " + redact(message));
  process.exit(1);
}

/** Node-spawned CLI, with no shell between us and argv. */
function run(cli, args, { env = {}, inherit = false } = {}) {
  try {
    return execFileSync(process.execPath, [cli, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      shell: false,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const detail = redact(e?.stderr || e?.stdout || e?.message || e);
    throw new Error(detail.split(/\r?\n/).slice(0, 12).join("\n"));
  }
}

const prisma = (args, opts) => run(PRISMA_CLI, args, opts);

// ---------------------------------------------------------------- 1. target

let url;
try {
  // The Neon CLI is a .cmd shim on Windows, so this one call needs a shell.
  // Its arguments contain no secrets; only its OUTPUT is sensitive.
  url = execFileSync("neon", ["connection-string", BRANCH], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
} catch (e) {
  fail(
    "could not get the connection string from the Neon CLI.\n" +
      "  Check that `neon connection-string production` works on its own.\n" +
      "  " + String(e?.message ?? e).split(/\r?\n/)[0],
  );
}

if (!/^postgres(ql)?:\/\//.test(url)) {
  fail("the Neon CLI did not return a connection string starting postgresql://");
}

let host, password;
try {
  const parsed = new URL(url);
  host = parsed.hostname;
  password = parsed.password;
} catch {
  fail("the connection string could not be parsed as a URL.");
}

// Register before any further output can possibly include them.
SECRETS = [url, password].filter(Boolean);

if (!host.startsWith(EXPECTED_HOST_PREFIX)) {
  fail(
    "that connection string does not point at the production branch.\n" +
      `  expected a host starting: ${EXPECTED_HOST_PREFIX}\n` +
      `  actually got:             ${host}\n` +
      "  Refusing to repoint at an unintended database.",
  );
}

console.log(`Target branch : ${BRANCH}`);
console.log(`Target host   : ${host}`);
console.log("Credentials   : resolved, not printed");

// ------------------------------------------------- 2. refuse if not migrated

function schemaGap() {
  const sql = prisma([
    "migrate",
    "diff",
    "--from-url",
    url,
    "--to-schema-datamodel",
    path.join("prisma", "schema.prisma"),
    "--script",
  ]);
  return sql.split(/\r?\n/).filter((l) => /^(CREATE|ALTER|DROP)\b/.test(l)).length;
}

let gap;
try {
  gap = schemaGap();
} catch (e) {
  fail("could not read the schema difference.\n  " + e.message);
}

console.log("");
console.log(`Schema gap    : ${gap} statement(s)`);

if (gap !== 0) {
  fail(
    `production is ${gap} statement(s) short of prisma/schema.prisma, so it is\n` +
      "  not migrated yet. Repointing now would hand the app an empty database.\n" +
      "  Run this first:\n" +
      "      node scripts/migrate-production.mjs",
  );
}

console.log("Migrated      : yes — schema matches prisma/schema.prisma");

// ---------------------------------------------------------------- 3. rewrite

if (!fs.existsSync(ENV_FILE)) fail(`.env not found at ${ENV_FILE}`);

const original = fs.readFileSync(ENV_FILE, "utf8");
const lines = original.split(/\r?\n/);

const urlIndex = lines.findIndex((l) => /^\s*DATABASE_URL\s*=/.test(l));
if (urlIndex === -1) fail(".env has no DATABASE_URL line to replace.");

const alreadyPointed = lines[urlIndex].includes(EXPECTED_HOST_PREFIX);
if (alreadyPointed) {
  console.log("");
  console.log(".env already points at production. Leaving it alone.");
} else {
  console.log("");
  console.log(`.env DATABASE_URL currently points at a different host (line ${urlIndex + 1}).`);
}

if (CHECK_ONLY) {
  console.log("");
  console.log("--check given: reporting only. Nothing written, nothing seeded.");
  process.exit(0);
}

if (!alreadyPointed) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(ROOT, `.env.backup-${stamp}`);
  fs.writeFileSync(backup, original, "utf8");
  console.log(`Backed up     : ${path.basename(backup)}`);

  // Replace the branch comment too, so the file does not keep claiming it
  // points at the expiring branch. Only lines that say so are touched.
  const next = lines.map((line, i) => {
    if (i === urlIndex) return `DATABASE_URL="${url}"`;
    if (/^#.*migration-test/.test(line)) {
      return "# Neon branch: production (the default branch — never expires).";
    }
    return line;
  });

  fs.writeFileSync(ENV_FILE, next.join("\n"), "utf8");
  console.log("Rewrote       : .env DATABASE_URL -> production");
}

// ------------------------------------------------------------------- 4. seed

console.log("");
console.log("Seeding production with prisma/seed.ts...");
console.log("");
try {
  run(TSX_CLI, [path.join("prisma", "seed.ts")], {
    env: { DATABASE_URL: url },
    inherit: true,
  });
} catch (e) {
  fail(
    "the seed failed. .env has already been repointed; restore it from the\n" +
      "  .env.backup-* file beside it if you need to go back.\n  " + e.message,
  );
}

// ----------------------------------------------------------------- 5. verify

let status;
try {
  status = prisma(["migrate", "status"], { env: { DATABASE_URL: url } });
} catch (e) {
  // `migrate status` exits non-zero when anything is pending, which is itself
  // the answer we want to report rather than a crash.
  status = e.message;
}

const pending = /have not yet been applied/i.test(status);

console.log("");
if (pending) {
  fail("migrations are still reported as pending:\n  " + status.split(/\r?\n/).slice(0, 8).join("\n  "));
}

console.log("PRODUCTION IS LIVE. Schema matches, seed applied, migrations recorded.");
console.log("");
console.log("The app now reads production. Restart the dev server to pick up .env:");
console.log("  npm run dev");
console.log("");
console.log("The expiring `migration-test` branch is no longer referenced by .env.");
console.log("Leave it until you have confirmed the app works, then it can go.");
