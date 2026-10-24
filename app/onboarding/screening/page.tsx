"use client";

import { useEffect, useState } from "react";
import { authFetch, NotSignedInError } from "@/lib/client-auth";

type Quote = { displayName: string; totalAmountCents: number };
type Charge = { status: string; totalAmountCents: number };

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

const STATUS_COPY: Record<string, string> = {
  QUOTED: "Not started",
  CHECKOUT_PENDING: "Checkout started — complete payment to continue",
  PAID: "Payment received — screening starting shortly",
  SCREENING_ORDERED: "Screening in progress",
  SCREENING_PENDING: "Screening in progress",
  APPROVED: "Approved",
  CONSIDER: "Under review",
  FAILED: "Payment failed — try again",
  CANCELED: "Checkout canceled",
  REFUNDED: "Refunded",
  DISPUTED: "Payment disputed — under review",
  WAIVED: "Waived by TempMovers",
};

export default function ScreeningOnboardingPage() {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [charge, setCharge] = useState<Charge | null>(null);
  const [complianceApproved, setComplianceApproved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [fcraAccepted, setFcraAccepted] = useState(false);
  const [starting, setStarting] = useState(false);

  function load() {
    authFetch("/api/screening/status")
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `Failed to load status (${res.status}).`);
        return res.json();
      })
      .then((data) => { setQuote(data.quote); setCharge(data.latestCharge); setComplianceApproved(data.complianceApproved); })
      .catch((e) => setError(e instanceof NotSignedInError ? "Sign in to continue verification." : e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      // The webhook is the source of truth for actually marking this paid —
      // this is just a courtesy refresh so the page doesn't look stale
      // while waiting for it to land.
      const interval = setInterval(load, 3000);
      setTimeout(() => clearInterval(interval), 30000);
      return () => clearInterval(interval);
    }
  }, []);

  async function startCheckout() {
    setStarting(true);
    setError(null);
    try {
      const res = await authFetch("/api/screening/checkout", {
        method: "POST",
        body: JSON.stringify({ feeDisclosureAccepted: termsAccepted, fcraAuthorizationAccepted: fcraAccepted }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not start checkout.");
      window.location.href = data.checkoutUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setStarting(false);
    }
  }

  if (loading) return <main style={{ padding: 40, textAlign: "center", color: "#637089" }}>Loading…</main>;
  if (error) return <main style={{ padding: 40, textAlign: "center", color: "#c93c4d" }}>{error}</main>;

  const hasStarted = charge && charge.status !== "QUOTED" && charge.status !== "CANCELED" && charge.status !== "FAILED";

  return (
    <main style={{ maxWidth: 520, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 22, marginBottom: 6 }}>Complete verification to unlock earning opportunities</h1>

      {complianceApproved ? (
        <p style={{ color: "#0f7e6b", fontWeight: 700, marginTop: 16 }}>You&apos;re approved — you can request and accept work.</p>
      ) : hasStarted && charge ? (
        <div style={{ border: "1px solid #dce4ef", borderRadius: 12, padding: 20, marginTop: 20 }}>
          <p style={{ fontSize: 13, color: "#637089", marginBottom: 4 }}>Screening status</p>
          <p style={{ fontWeight: 800, fontSize: 16 }}>{STATUS_COPY[charge.status] ?? charge.status}</p>
          {charge.status === "FAILED" || charge.status === "CANCELED" ? (
            <p style={{ marginTop: 10, fontSize: 13, color: "#637089" }}>You can try checkout again below.</p>
          ) : null}
        </div>
      ) : quote ? (
        <div style={{ border: "1px solid #dce4ef", borderRadius: 12, padding: 20, marginTop: 20 }}>
          <p style={{ fontSize: 13, color: "#637089", marginBottom: 4 }}>One-time screening fee</p>
          <p style={{ fontWeight: 800, fontSize: 22, marginBottom: 12 }}>{money(quote.totalAmountCents)}</p>
          <p style={{ fontSize: 13, color: "#637089", marginBottom: 16 }}>
            Payment options shown at checkout may include card, Apple Pay, Google Pay, and Afterpay when eligible.
          </p>
          <p style={{ fontSize: 12, color: "#637089", marginBottom: 16 }}>
            Payment begins the screening process and does not guarantee approval. Additional role credentials may be
            required. Exact customer and location details are available only after assignment.
          </p>

          <label style={{ display: "flex", gap: 8, fontSize: 13, marginBottom: 10, alignItems: "flex-start" }}>
            <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} style={{ marginTop: 3 }} />
            <span>I have read and accept the screening fee disclosure.</span>
          </label>
          <label style={{ display: "flex", gap: 8, fontSize: 13, marginBottom: 18, alignItems: "flex-start" }}>
            <input type="checkbox" checked={fcraAccepted} onChange={(e) => setFcraAccepted(e.target.checked)} style={{ marginTop: 3 }} />
            <span>I authorize TempMovers to obtain a consumer report for employment screening purposes (FCRA).</span>
          </label>

          <button
            disabled={!termsAccepted || !fcraAccepted || starting}
            onClick={startCheckout}
            style={{
              width: "100%", padding: 12, borderRadius: 8, border: "none", fontWeight: 800,
              background: termsAccepted && fcraAccepted ? "#246bfd" : "#dce4ef", color: termsAccepted && fcraAccepted ? "white" : "#637089",
              cursor: termsAccepted && fcraAccepted ? "pointer" : "not-allowed",
            }}
          >
            {starting ? "Redirecting…" : "Continue to secure checkout"}
          </button>
        </div>
      ) : (
        <p style={{ color: "#637089", marginTop: 16 }}>No screening package is configured for your role yet — check back soon.</p>
      )}
    </main>
  );
}
