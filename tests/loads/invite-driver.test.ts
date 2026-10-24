import { describe, it, expect } from "vitest";
import { renderInvitationTemplate } from "@/lib/loads/invitation-template";

// renderInvitationTemplate is the only genuinely new *pure* logic in
// Phase 4 — the rest (eligibility, upsert, notify) is DB-bound and
// covered by the manual end-to-end checklist in the handoff doc, not a
// unit test, since this sandbox has no live database. Token
// substitution, by contrast, is fully testable in isolation.
const tokens = {
  driverName: "Jordan Lee",
  loadTitle: "Indy → Chicago reefer",
  pickupDate: new Date("2026-08-01T14:00:00Z"),
  expiresAt: new Date("2026-08-01T16:00:00Z"),
};

describe("renderInvitationTemplate", () => {
  it("substitutes every known token in subject and body", () => {
    const out = renderInvitationTemplate(
      { subject: "You're invited: {loadTitle}", body: "Hi {driverName}, pickup {pickupDate}. Expires {expiresAt}." },
      tokens
    );
    expect(out.subject).toBe(`You're invited: ${tokens.loadTitle}`);
    expect(out.body).toContain(tokens.driverName);
    expect(out.body).toContain(tokens.pickupDate.toLocaleString());
    expect(out.body).toContain(tokens.expiresAt.toLocaleString());
    // No un-substituted known token should remain.
    expect(out.body).not.toMatch(/\{(driverName|loadTitle|pickupDate|expiresAt)\}/);
  });

  it("leaves an unknown token literally in place rather than deleting it", () => {
    // A customer typo should be visibly wrong, not silently vanish.
    const out = renderInvitationTemplate({ subject: "Hi {notAToken}", body: "x" }, tokens);
    expect(out.subject).toBe("Hi {notAToken}");
  });

  it("handles a template that uses no tokens at all", () => {
    const out = renderInvitationTemplate({ subject: "Static subject", body: "Static body" }, tokens);
    expect(out).toEqual({ subject: "Static subject", body: "Static body" });
  });

  it("substitutes a token that appears more than once", () => {
    const out = renderInvitationTemplate({ subject: "{driverName} — {driverName}", body: "y" }, tokens);
    expect(out.subject).toBe(`${tokens.driverName} — ${tokens.driverName}`);
  });
});
