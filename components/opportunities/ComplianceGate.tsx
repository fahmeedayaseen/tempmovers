"use client";

import type { ReactNode } from "react";

export type AccessDecision = {
  allowed: boolean;
  reasonCode?: string;
  missingRequirements: string[];
};

const REASON_LABELS: Record<string, string> = {
  COMPLIANCE_INCOMPLETE: "Complete verification to unlock this opportunity",
  ACCOUNT_NOT_ACTIVE: "Your account isn't active yet",
  ASSIGNMENT_REQUIRED: "Full details are available once you're assigned",
};

/**
 * Wraps a request/accept action button. Shows the locked-state label and
 * checklist WITHOUT ever receiving or rendering the private opportunity
 * data itself — this component only ever sees an AccessDecision, never the
 * job/load record. The actual protection is server-side (see
 * lib/access/opportunity-access.ts and the sanitized DTOs); this is the UI
 * reflection of that, not a substitute for it.
 */
export default function ComplianceGate({
  decision, lockedLabel, onContinue, children,
}: {
  decision: AccessDecision;
  lockedLabel: string;
  onContinue: () => void;
  children: ReactNode;
}) {
  if (decision.allowed) return <>{children}</>;

  return (
    <div style={{ border: "1px solid #dce4ef", borderRadius: 10, padding: 14, background: "#f3f6fb" }}>
      <p style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
        {REASON_LABELS[decision.reasonCode ?? ""] ?? lockedLabel}
      </p>
      {decision.missingRequirements.length > 0 && (
        <ul style={{ margin: "6px 0 10px", paddingLeft: 18, fontSize: 12, color: "#637089" }}>
          {decision.missingRequirements.map((req) => (
            <li key={req}>{req.replaceAll("_", " ").toLowerCase()}</li>
          ))}
        </ul>
      )}
      <button
        onClick={onContinue}
        style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "#246bfd", color: "white", fontWeight: 700, fontSize: 13, cursor: "pointer" }}
      >
        {lockedLabel}
      </button>
    </div>
  );
}
