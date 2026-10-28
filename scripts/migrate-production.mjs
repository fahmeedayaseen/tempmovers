/**
 * Apply pending Prisma migrations to the Neon `production` branch.
 *
 * VASRUE Digital Media — Clinton Douglas IV. Contract #2942026-1353.
 *
 * WHY THIS EXISTS
 * The app's DATABASE_URL points at the Neon branch `migration-test`, which
 * EXPIRES 31 Oct 2026. The default branch `production` never expires and is
 * empty. Everything built has to move there before that date or it is gone.
 *
 * Doing that by hand means pasting a connection string into a shell, and the
 * shell syntax differs between PowerShell and bash — which is how the first
 * attempt silently did nothing. This script is shell-independent: run it with
 * `node scripts/migrate-production.mjs` and it behaves the same in PowerShell,
 * cmd and bash.
 *
 * TWO THINGS THIS SCRIPT IS CAREFUL ABOUT, BOTH LEARNED THE HARD WAY
 *
 * 1. It never spawns a shell for anything holding the connection string.
 *    A Neon URL ends in `?sslmode=require&channel_binding=require`. Through a
 *    Windows shell that `&` is a command separator, so the rest of the command
 *    line is silently discarded — the first version of this script lost its
 *    `--to-schema-datamodel` argument exactly that way. Prisma is therefore
 *    invoked directly as `node node_modules/prisma/build/index.js`, with the
 *    URL passed as a real argv entry rather than a string a shell re-parses.
 *
 * 2. It redacts the URL out of every message it prints, including the text of
 *    thrown errors. execFileSync puts the whole command line in its error
 *    message, so an unredacted failure prints the database password. Every
 *    output path here goes through redact().
 *
 * SAFETY
 *  - Verifies the resolved string points at the production branch host before
 *    doing anything. A wrong target aborts.
 *  - `migrate deploy` only applies migrations already committed under
 *    prisma/migrations. It never generates SQL and never resets.
 *  - Aborts if the pending diff contains any DROP. This migration is additive.
 *  - Measures the schema gap before and after, so success is verified rather
 *    than assumed.
 *
 * Run with:
 *   node scripts/migrate-production.mjs            # apply
 *   node scripts/migrate-production.mjs --check    # report only, change nothing
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

const PRISMA_CLI = path.join(ROOT, "node_modules", "prisma", "build", "index.js");
if (!fs.existsSync(PRISMA_CLI)) {
  console.error(`Cannot find the Prisma CLI at ${PRISMA_CLI}. Run npm ci first.`);
  process.exit(1);
}

/** Everything printed goes through this. See note 2 in the header. */
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

/** Prisma, with no shell between us and argv. */
function prisma(args, { env = {}, inherit = false } = {}) {
  try {
    return execFileSync(process.execPath, [PRISMA_CLI, ...args], {
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
  fail(
    "the Neon CLI did not return a connection string.\n" +
      `  It returned ${url.length} characters that do not start with postgresql://\n` +
      "  Run `neon connection-string production` on its own to see what it says.",
  );
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
      "  Refusing to migrate an unintended database.",
  );
}

console.log(`Target branch : ${BRANCH}`);
console.log(`Target host   : ${host}`);
console.log("Credentials   : resolved, not printed");

// ---------------------------------------------------------------- 2. before

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
  const stmts = sql.split(/\r?\n/).filter((l) => /^(CREATE|ALTER|DROP)\b/.test(l));
  return { total: stmts.length, drops: stmts.filter((l) => l.startsWith("DROP")).length };
}

let before;
try {
  before = schemaGap();
} catch (e) {
  fail("could not read the schema difference.\n  " + e.message);
}

console.log("");
console.log(`Schema gap before : ${before.total} statement(s), ${before.drops} DROP(s)`);

if (before.total === 0) {
  console.log("");
  console.log("Nothing to do — production already matches prisma/schema.prisma.");
  process.exit(0);
}

if (before.drops > 0) {
  fail(
    `the pending diff contains ${before.drops} DROP statement(s). This migration is\n` +
      "  meant to be purely additive. Stopping rather than risking data loss.",
  );
}

if (CHECK_ONLY) {
  console.log("");
  console.log("--check given: reporting only, nothing applied.");
  process.exit(0);
}

// ---------------------------------------------------------------- 3. apply

console.log("");
console.log("Applying migrations with `prisma migrate deploy`...");
console.log("");
try {
  prisma(["migrate", "deploy"], { env: { DATABASE_URL: url }, inherit: true });
} catch (e) {
  fail("prisma migrate deploy failed.\n  " + e.message);
}

// ---------------------------------------------------------------- 4. verify

let after;
try {
  after = schemaGap();
} catch (e) {
  fail("migrations ran but the result could not be verified.\n  " + e.message);
}

console.log("");
console.log(`Schema gap after  : ${after.total} statement(s)`);

if (after.total !== 0) {
  fail(
    `production still differs from the schema by ${after.total} statement(s).\n` +
      "  The migration did not fully apply. Do not repoint .env yet.",
  );
}

console.log("");
console.log("PRODUCTION IS MIGRATED. Schema matches prisma/schema.prisma exactly.");
console.log("");
console.log("Next: DATABASE_URL in .env still points at the expiring `migration-test`");
console.log("branch. It needs repointing at production, and production needs seeding.");
