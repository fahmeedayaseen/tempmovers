"use client";

import { useEffect, useRef, useState } from "react";
import { authFetch, NotSignedInError } from "@/lib/client-auth";
import { loadStripeClient, type StripeInstance, type StripeElements, type StripeElement } from "@/lib/stripe-client";

/**
 * Customer "leave a tip" flow — a separate, smaller component from
 * StripePaymentForm rather than a reused/generalized version of it: the
 * surrounding UX genuinely differs (an amount the customer chooses,
 * quick-pick buttons, no pre-computed total), and forcing one component
 * to cover both would have meant threading amount-entry state through
 * a component that was built and verified around a fixed amount.
 *
 * Same runtime-verification caveat as StripePaymentForm — see that
 * component's docblock and the README's Workstream A section for the
 * full account; not repeated here.
 */
type TipEntityType = "job" | "load";
type Status = "choosing_amount" | "creating_intent" | "loading_stripe" | "ready" | "confirming" | "succeeded" | "error";

const QUICK_AMOUNTS_CENTS = [1000, 2000, 3000];

export default function TipForm({ entityType, entityId, onSuccess }: { entityType: TipEntityType; entityId: string; onSuccess?: () => void }) {
  const [status, setStatus] = useState<Status>("choosing_amount");
  const [amountInput, setAmountInput] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const stripeRef = useRef<StripeInstance | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const paymentElementRef = useRef<StripeElement | null>(null);
  const mountPointRef = useRef<HTMLDivElement | null>(null);

  const tipPath = entityType === "job" ? `/api/jobs/${entityId}/tip` : `/api/loads/${entityId}/tip`;

  async function startTip(amountCents: number) {
    if (amountCents < 100) {
      setErrorMessage("Tip must be at least $1.00.");
      return;
    }
    setStatus("creating_intent");
    setErrorMessage(null);
    try {
      const res = await authFetch(tipPath, { method: "POST", body: JSON.stringify({ amountCents }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not start tip payment (${res.status}).`);

      setStatus("loading_stripe");
      const stripe = await loadStripeClient();
      stripeRef.current = stripe;
      const elements = stripe.elements({ clientSecret: data.clientSecret, appearance: { theme: "stripe" } });
      elementsRef.current = elements;
      paymentElementRef.current = elements.create("payment");
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setErrorMessage(e instanceof NotSignedInError ? "Sign in to leave a tip." : e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  useEffect(() => {
    if (status === "ready" && mountPointRef.current && paymentElementRef.current) {
      paymentElementRef.current.mount(mountPointRef.current);
    }
  }, [status]);

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!stripeRef.current || !elementsRef.current) return;
    setStatus("confirming");
    setErrorMessage(null);
    try {
      const result = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        redirect: "if_required",
        confirmParams: { return_url: typeof window !== "undefined" ? window.location.href : undefined },
      });
      if (result.error) {
        setStatus("error");
        setErrorMessage(result.error.message ?? "Tip could not be confirmed.");
        return;
      }
      setStatus("succeeded");
      onSuccess?.();
    } catch (e) {
      setStatus("error");
      setErrorMessage(e instanceof Error ? e.message : "Tip could not be confirmed.");
    }
  }

  if (status === "succeeded") {
    return <p className="footerNote" style={{ color: "#1a7f37" }}>Thank you! Your tip is on its way — 100% goes to the worker(s), no platform fee.</p>;
  }

  return (
    <div className="panel" style={{ background: "#f7f9fc", marginTop: 10 }}>
      {status === "choosing_amount" && (
        <>
          <p className="footerNote" style={{ marginTop: 0 }}>Leave a tip — 100% goes directly to the worker(s), no platform fee.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            {QUICK_AMOUNTS_CENTS.map((c) => (
              <button key={c} className="btn btnSecondary" onClick={() => startTip(c)}>${(c / 100).toFixed(0)}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Custom amount ($)</label>
              <input type="number" min="1" step="0.01" value={amountInput} onChange={(e) => setAmountInput(e.target.value)} />
            </div>
            <button className="btn btnPrimary" onClick={() => startTip(Math.round(Number(amountInput) * 100))} disabled={!amountInput}>Tip this amount</button>
          </div>
        </>
      )}
      {(status === "creating_intent" || status === "loading_stripe") && <p className="footerNote">Preparing secure payment form…</p>}
      {(status === "ready" || status === "confirming") && (
        <form onSubmit={handleConfirm}>
          <div ref={mountPointRef} style={{ minHeight: 200, marginBottom: 12 }} />
          <button className="btn btnPrimary" type="submit" disabled={status === "confirming"}>{status === "confirming" ? "Confirming…" : "Send tip"}</button>
        </form>
      )}
      {status === "error" && (
        <>
          <p className="footerNote" style={{ color: "#b3261e" }}>{errorMessage}</p>
          <button className="btn btnSecondary" onClick={() => setStatus("choosing_amount")}>Try again</button>
        </>
      )}
    </div>
  );
}
