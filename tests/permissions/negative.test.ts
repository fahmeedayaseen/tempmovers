/**
 * N1–N11 permission negative tests (role/permission matrix).
 *
 * These call the REAL exported route handlers with REAL authenticated sessions
 * against the migrated test database. Each asserts the server itself denies
 * (401/403) or omits privileged data — not that a UI hides a button. If a guard
 * is later weakened, the corresponding test fails.
 *
 * Run against a migrated, seeded test DB (brokerage flags OFF by default).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { makeUser, makeCarrier, makeLoad, grantDispatcher, authedRequest, setBrokerageFlag, bodyOf } from "./harness";

// Route handlers under test (actual exports).
import { GET as carrierFactoringGET } from "@/app/api/carriers/factoring/route";
import { POST as freightSettlementsPOST } from "@/app/api/freight/settlements/route";
import { GET as adminCarriersGET } from "@/app/api/admin/carriers/route";
import { GET as dispatcherLoadsGET } from "@/app/api/dispatcher/carriers/[carrierId]/loads/route";
import { PATCH as dispatcherStatusPATCH } from "@/app/api/dispatcher/loads/[loadId]/status/route";
import { GET as shipperLoadDetailGET } from "@/app/api/shipper/loads/[loadId]/route";
import { GET as carrierAppGET } from "@/app/api/carriers/application/route";
import { PATCH as freightLoadPATCH } from "@/app/api/freight/loads/route";
import { GET as recruitingProspectsGET } from "@/app/api/recruiting/prospects/route";

const FORBIDDEN_SHIPPER_FIELDS = ["carrierLinehaulCents", "carrierFuelSurchargeCents", "carrierAccessorialsCents", "carrierTotalCents", "grossMarginCents", "platformRevenueCents", "processingFeesCents"];

// Deep scan a JSON value for any forbidden key.
function containsForbiddenKey(obj: unknown, keys: string[]): string | null {
  if (obj === null || typeof obj !== "object") return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(k)) return k;
    const nested = containsForbiddenKey(v, keys);
    if (nested) return nested;
  }
  return null;
}

beforeAll(async () => {
  // First staging run keeps brokerage OFF (test fixtures, not production on).
  await setBrokerageFlag("FREIGHT_BROKERAGE_ENABLED", false);
  await setBrokerageFlag("LOAD_POSTING_ENABLED", false);
});

describe("N1 — recruiter blocked from factoring/settlements", () => {
  it("recruiter → carrier factoring is 401/403", async () => {
    const r = await makeUser("RECRUITER");
    const res = await carrierFactoringGET(authedRequest(r.jwt, "/api/carriers/factoring"));
    expect([401, 403]).toContain(res.status);
  });
  it("recruiter → freight settlements is 401/403", async () => {
    const r = await makeUser("RECRUITER");
    const res = await freightSettlementsPOST(authedRequest(r.jwt, "/api/freight/settlements", { method: "POST", body: JSON.stringify({}) }));
    expect([401, 403]).toContain(res.status);
  });
});

describe("N2 — dispatcher blocked from admin", () => {
  it("dispatcher → admin carriers is 401/403", async () => {
    const d = await makeUser("DISPATCHER");
    const res = await adminCarriersGET(authedRequest(d.jwt, "/api/admin/carriers"));
    expect([401, 403]).toContain(res.status);
  });
});

describe("N3 — dispatcher blocked from a non-granted carrier", () => {
  it("dispatcher with no grant → that carrier's loads is 403", async () => {
    const owner = await makeUser("CARRIER");
    const carrier = await makeCarrier(owner.id);
    const d = await makeUser("DISPATCHER"); // no grant created
    const res = await dispatcherLoadsGET(authedRequest(d.jwt, `/api/dispatcher/carriers/${carrier.id}/loads`), { params: { carrierId: carrier.id } });
    expect(res.status).toBe(403);
  });
});

describe("N4 — VIEW_LOADS alone cannot update status", () => {
  it("dispatcher granted only VIEW_LOADS → status update is 403", async () => {
    const owner = await makeUser("CARRIER");
    const carrier = await makeCarrier(owner.id);
    const d = await makeUser("DISPATCHER");
    await grantDispatcher(d.id, carrier.id, ["VIEW_LOADS"]); // NOT UPDATE_LOAD_STATUS
    const load = await makeLoad({ assignedCarrierId: carrier.id, status: "DISPATCHED" });
    const res = await dispatcherStatusPATCH(
      authedRequest(d.jwt, `/api/dispatcher/loads/${load.id}/status`, { method: "PATCH", body: JSON.stringify({ toStatus: "AT_PICKUP" }) }),
      { params: { loadId: load.id } },
    );
    expect(res.status).toBe(403);
  });
});

describe("N5 — Carrier A cannot access Carrier B", () => {
  it("carrier B's session sees no carrier A data via application GET", async () => {
    const a = await makeUser("CARRIER");
    await makeCarrier(a.id, { legalBusinessName: "Carrier A Co" });
    const b = await makeUser("CARRIER"); // different owner, no carrier of their own
    const res = await carrierAppGET(authedRequest(b.jwt, "/api/carriers/application"));
    // B either gets 404 (no own carrier) or their own — never A's record.
    const body = await bodyOf(res);
    const leaked = JSON.stringify(body).includes("Carrier A Co");
    expect(leaked).toBe(false);
  });
});

describe("N6 — shipper response contains no carrier-pay/margin fields", () => {
  it("serialized shipper load detail omits all forbidden pricing keys", async () => {
    const shipper = await makeUser("CUSTOMER");
    const load = await makeLoad({ shipperUserId: shipper.id, status: "IN_TRANSIT" });
    const res = await shipperLoadDetailGET(authedRequest(shipper.jwt, `/api/shipper/loads/${load.id}`), { params: { loadId: load.id } });
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const found = containsForbiddenKey(body, FORBIDDEN_SHIPPER_FIELDS);
    expect(found).toBeNull(); // no carrier*/margin/platform/fees anywhere in the JSON
  });
});

describe("N7 — carrier identity hidden before allowed dispatch stage", () => {
  it("shipper sees no carrier name while load is in offer-shopping (OFFERED)", async () => {
    const shipper = await makeUser("CUSTOMER");
    const carrierOwner = await makeUser("CARRIER");
    const carrier = await makeCarrier(carrierOwner.id, { legalBusinessName: "Secret Carrier LLC" });
    const load = await makeLoad({ shipperUserId: shipper.id, assignedCarrierId: carrier.id, status: "OFFERED" });
    const res = await shipperLoadDetailGET(authedRequest(shipper.jwt, `/api/shipper/loads/${load.id}`), { params: { loadId: load.id } });
    const body = await bodyOf(res);
    expect(body.carrierName ?? null).toBeNull();
    expect(JSON.stringify(body).includes("Secret Carrier LLC")).toBe(false);
  });
  it("shipper sees carrier name once DISPATCHED", async () => {
    const shipper = await makeUser("CUSTOMER");
    const carrierOwner = await makeUser("CARRIER");
    const carrier = await makeCarrier(carrierOwner.id, { legalBusinessName: "Visible Carrier LLC" });
    const load = await makeLoad({ shipperUserId: shipper.id, assignedCarrierId: carrier.id, status: "DISPATCHED" });
    const res = await shipperLoadDetailGET(authedRequest(shipper.jwt, `/api/shipper/loads/${load.id}`), { params: { loadId: load.id } });
    const body = await bodyOf(res);
    expect(body.carrierName).toBe("Visible Carrier LLC");
  });
});

describe("N8 — support blocked from finance/payment routing", () => {
  it("support → freight settlements is 401/403", async () => {
    const s = await makeUser("SUPPORT");
    const res = await freightSettlementsPOST(authedRequest(s.jwt, "/api/freight/settlements", { method: "POST", body: JSON.stringify({}) }));
    expect([401, 403]).toContain(res.status);
  });
});

describe("N9 — unauthorized roles blocked from settlement preparation", () => {
  it.each(["CUSTOMER", "MOVER", "DRIVER", "CARRIER", "DISPATCHER", "RECRUITER", "SUPPORT"] as const)(
    "%s → freight settlements is 401/403", async (role) => {
      const u = await makeUser(role);
      const res = await freightSettlementsPOST(authedRequest(u.jwt, "/api/freight/settlements", { method: "POST", body: JSON.stringify({}) }));
      expect([401, 403]).toContain(res.status);
    },
  );
});

describe("N10 — brokerage writes blocked while flags OFF", () => {
  it("even an admin cannot transition a load while brokerage is OFF", async () => {
    await setBrokerageFlag("FREIGHT_BROKERAGE_ENABLED", false);
    await setBrokerageFlag("LOAD_POSTING_ENABLED", false);
    const admin = await makeUser("ADMIN");
    const load = await makeLoad({ status: "AVAILABLE" });
    const res = await freightLoadPATCH(authedRequest(admin.jwt, "/api/freight/loads", { method: "PATCH", body: JSON.stringify({ loadId: load.id, toStatus: "OFFERED" }) }));
    expect(res.status).toBe(403); // capability gate, not role
  });
});

describe("N11 — base roles locked out of carrier/recruiting/dispatcher/freight ops", () => {
  it.each(["CUSTOMER", "MOVER", "DRIVER"] as const)(
    "%s → admin carriers is 401/403", async (role) => {
      const u = await makeUser(role);
      const res = await adminCarriersGET(authedRequest(u.jwt, "/api/admin/carriers"));
      expect([401, 403]).toContain(res.status);
    },
  );
  it.each(["CUSTOMER", "MOVER", "DRIVER"] as const)(
    "%s → recruiting prospects is 401/403", async (role) => {
      const u = await makeUser(role);
      const res = await recruitingProspectsGET(authedRequest(u.jwt, "/api/recruiting/prospects"));
      expect([401, 403]).toContain(res.status);
    },
  );
  it.each(["CUSTOMER", "MOVER", "DRIVER"] as const)(
    "%s → freight settlements is 401/403", async (role) => {
      const u = await makeUser(role);
      const res = await freightSettlementsPOST(authedRequest(u.jwt, "/api/freight/settlements", { method: "POST", body: JSON.stringify({}) }));
      expect([401, 403]).toContain(res.status);
    },
  );
});
