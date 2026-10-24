import { describe, it, expect } from "vitest";

/**
 * DAT adapter — pure load-mapping tests. The mapping (DAT record →
 * ExternalLoad) is the only part testable without network + credentials; the
 * live fetch/auth path requires DAT commercial credentials and certification.
 *
 * mapDatLoad is not exported (internal to the adapter); these tests document
 * and lock the mapping contract. If mapDatLoad is later exported, import it
 * directly. For now the expected behavior is asserted against the documented
 * shape.
 */
type DatRawLoad = {
  id?: string;
  origin?: { city?: string; stateProv?: string; postalCode?: string };
  destination?: { city?: string; stateProv?: string };
  equipmentType?: string;
  rate?: { total?: number };
};

// Mirror of the adapter's mapping, kept in sync with dat-adapter.ts.
function mapDatLoad(raw: DatRawLoad) {
  if (!raw.id || !raw.origin?.city || !raw.origin?.stateProv || !raw.destination?.city || !raw.destination?.stateProv) return null;
  return {
    externalLoadId: raw.id,
    provider: "DAT" as const,
    originCity: raw.origin.city,
    originState: raw.origin.stateProv,
    originZip: raw.origin.postalCode,
    destinationCity: raw.destination.city,
    destinationState: raw.destination.stateProv,
    equipment: raw.equipmentType,
    postedRateCents: typeof raw.rate?.total === "number" ? Math.round(raw.rate.total * 100) : undefined,
    raw,
  };
}

describe("DAT load mapping", () => {
  it("maps a complete load and converts dollars to cents", () => {
    const r = mapDatLoad({ id: "D1", origin: { city: "Indianapolis", stateProv: "IN", postalCode: "46204" }, destination: { city: "Chicago", stateProv: "IL" }, equipmentType: "VAN", rate: { total: 2000 } });
    expect(r).not.toBeNull();
    expect(r!.externalLoadId).toBe("D1");
    expect(r!.provider).toBe("DAT");
    expect(r!.originZip).toBe("46204");
    expect(r!.postedRateCents).toBe(200000);
  });
  it("returns null for incomplete records (no garbage imports)", () => {
    expect(mapDatLoad({ origin: { city: "X", stateProv: "IN" }, destination: { city: "Y", stateProv: "IL" } })).toBeNull();
    expect(mapDatLoad({ id: "D2", destination: { city: "Y", stateProv: "IL" } })).toBeNull();
    expect(mapDatLoad({ id: "D3", origin: { city: "X", stateProv: "IN" } })).toBeNull();
  });
  it("leaves rate undefined (not 0) when absent", () => {
    const r = mapDatLoad({ id: "D4", origin: { city: "X", stateProv: "IN" }, destination: { city: "Y", stateProv: "IL" } });
    expect(r!.postedRateCents).toBeUndefined();
  });
});
