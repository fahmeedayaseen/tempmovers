import { describe, it, expect } from "vitest";
import { PUBLIC_PORTFOLIO_MEDIA_SELECT, OWNER_PORTFOLIO_MEDIA_SELECT, toPublicMedia } from "@/lib/portfolio/public-select";

// Security guard (Phase 5.5A): the public serializer must never select a
// private field. This is a compile-time-ish contract expressed as a
// runtime test so a future edit that adds e.g. storageKey to the public
// select fails loudly.
const FORBIDDEN = ["storageKey", "thumbnailKey", "moderationNote", "approvedById", "rejectedById", "removedById", "rejectionReason", "publicAssetId"];

describe("PUBLIC_PORTFOLIO_MEDIA_SELECT", () => {
  it("selects no forbidden private field", () => {
    const keys = Object.keys(PUBLIC_PORTFOLIO_MEDIA_SELECT);
    for (const f of FORBIDDEN) expect(keys).not.toContain(f);
  });
  it("selects the expected public fields", () => {
    const keys = Object.keys(PUBLIC_PORTFOLIO_MEDIA_SELECT);
    for (const f of ["id", "title", "description", "isPrimary", "displayOrder", "approvedAt"]) expect(keys).toContain(f);
  });
});

describe("OWNER_PORTFOLIO_MEDIA_SELECT", () => {
  it("may include moderation status + worker-visible reason but not raw keys or internal notes", () => {
    const keys = Object.keys(OWNER_PORTFOLIO_MEDIA_SELECT);
    expect(keys).toContain("status");
    expect(keys).toContain("rejectionReason"); // worker-visible
    for (const f of ["storageKey", "thumbnailKey", "moderationNote"]) expect(keys).not.toContain(f);
  });
});

describe("toPublicMedia", () => {
  it("attaches resolved URLs without mutating private data in", () => {
    const out = toPublicMedia({ id: "x", title: "t" }, "https://signed/delivery", "https://signed/thumb");
    expect(out).toEqual({ id: "x", title: "t", deliveryUrl: "https://signed/delivery", thumbnailUrl: "https://signed/thumb" });
  });
});
