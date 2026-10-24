/**
 * End-to-end smoke test for the Indianapolis launch market flow.
 *
 * This is NOT a substitute for real testing — it's a scripted walk through the
 * full flow against a real running instance (local dev server + seeded Postgres
 * + Stripe test keys), so a human can watch it happen and see exactly where it
 * breaks. Nothing in this sandbox can run a Postgres instance or a live Next.js
 * server, so this script has never actually been executed — treat every step
 * as "should work given the code," not "verified working."
 *
 * Run with: npm run dev (separate terminal), then:
 *   npx tsx scripts/smoke-test.ts
 *
 * Requires: DATABASE_URL pointed at a migrated + seeded dev database,
 * STRIPE_SECRET_KEY set to a real test-mode key (subscription/payment steps
 * are skipped with a warning if Stripe isn't configured).
 */

const BASE_URL = process.env.SMOKE_TEST_BASE_URL ?? "http://localhost:3000";

type Ctx = Record<string, string>;

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function step(label: string, fn: () => Promise<void>) {
  process.stdout.write(`→ ${label}... `);
  try {
    await fn();
    console.log("ok");
  } catch (e) {
    console.log("FAILED");
    console.error(e);
    process.exit(1);
  }
}

async function main() {
  const ctx: Ctx = {};
  const stamp = Date.now();

  await step("Register a customer (Indianapolis)", async () => {
    const r = await call("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: `smoke-customer-${stamp}@example.com`, password: "correcthorsebatterystaple",
        firstName: "Smoke", lastName: "Customer", role: "CUSTOMER",
      }),
    });
    ctx.customerToken = r.token;
  });

  await step("Register a mover", async () => {
    const r = await call("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: `smoke-mover-${stamp}@example.com`, password: "correcthorsebatterystaple",
        firstName: "Smoke", lastName: "Mover", role: "MOVER", workerType: "MOVER",
      }),
    });
    ctx.moverToken = r.token;
  });

  await step("Reject a moving-job quote below the 2-mover/3-hour floor", async () => {
    const res = await fetch(`${BASE_URL}/api/quotes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ movers: 1, estimatedHours: 1 }),
    });
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
  });

  await step("Accept a moving-job quote at exactly the floor ($231.95 expected at the platform default rate)", async () => {
    const r = await call("/api/quotes", {
      method: "POST",
      body: JSON.stringify({ movers: 2, estimatedHours: 3 }),
    });
    if (r.totalCents !== 23195) throw new Error(`expected 23195 cents, got ${r.totalCents}`);
  });

  await step("Browse the public load board (no auth required)", async () => {
    const r = await call("/api/loads");
    if (!Array.isArray(r.loads)) throw new Error("expected loads array");
    const anyPrivateFieldLeaked = r.loads.some((l: Record<string, unknown>) =>
      "exactPickupAddress" in l || "shipperContactPhone" in l || "accessCode" in l);
    if (anyPrivateFieldLeaked) throw new Error("SECURITY: sensitive load fields leaked from public endpoint");
  });

  await step("Reject a load request with no auth token", async () => {
    const res = await fetch(`${BASE_URL}/api/loads/nonexistent-id/request`, { method: "POST" });
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  });

  await step("Reject an admin pricing update from a non-admin token", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/pricing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.moverToken}` },
      body: JSON.stringify({ marketCode: "INDY" }),
    });
    if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`);
  });

  console.log("\nAll smoke-test assertions passed against", BASE_URL);
  console.log("This covers auth, pricing floors, public load-board field-stripping, and role gating.");
  console.log("It does NOT cover: Stripe charge/payout completion, GPS check-in/out, POD upload,");
  console.log("bonus qualification math, or partner invoicing — extend this script before relying on it.");
}

main();
