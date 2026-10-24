import { describe, it, expect } from "vitest";
import { evaluateRemittanceChange } from "@/lib/carriers/payment-routing";

const activeVerified = { status: "ACTIVE" as const, noaVerified: true };

describe("payment-routing change control under a Notice of Assignment", () => {
  it("a carrier cannot change remittance under an active verified NOA, even with a document", () => {
    const d = evaluateRemittanceChange(activeVerified, { actorIsAdmin: false, hasSupportingDocument: true });
    expect(d.allowed).toBe(false);
    expect(d.requiresReview).toBe(true);
  });

  it("an admin without supporting documentation is still blocked", () => {
    const d = evaluateRemittanceChange(activeVerified, { actorIsAdmin: true, hasSupportingDocument: false });
    expect(d.allowed).toBe(false);
  });

  it("an admin with supporting documentation may change it", () => {
    const d = evaluateRemittanceChange(activeVerified, { actorIsAdmin: true, hasSupportingDocument: true });
    expect(d.allowed).toBe(true);
  });

  it("an unverified NOA does not lock routing", () => {
    const d = evaluateRemittanceChange({ status: "ACTIVE", noaVerified: false }, { actorIsAdmin: false, hasSupportingDocument: false });
    expect(d.allowed).toBe(true);
  });

  it("no active assignment means the carrier may set remittance", () => {
    expect(evaluateRemittanceChange(null, { actorIsAdmin: false, hasSupportingDocument: false }).allowed).toBe(true);
  });

  it("a revoked or superseded assignment does not lock routing", () => {
    expect(evaluateRemittanceChange({ status: "REVOKED", noaVerified: true }, { actorIsAdmin: false, hasSupportingDocument: false }).allowed).toBe(true);
    expect(evaluateRemittanceChange({ status: "SUPERSEDED", noaVerified: true }, { actorIsAdmin: false, hasSupportingDocument: false }).allowed).toBe(true);
  });
});
