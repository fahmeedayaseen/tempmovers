"use client";

import { useEffect, useRef, useState } from "react";
import { authFetch, NotSignedInError } from "@/lib/client-auth";
import { loadStripeClient, type StripeInstance, type StripeElements, type StripeElement } from "@/lib/stripe-client";

/**
 * Customer payment authorization UI — Workstream A. Builds a real
 * PaymentElement flow against the existing, already-correct backend
 * (job-payment-intent / driver-payment-intent, and the webhook
 * reconciliation that confirms the result), using Stripe.js loaded from
 * CDN rather than the @stripe/stripe-js npm package (see
 * lib/stripe-client.ts for exactly why).
 *
 * UNVERIFIED AT RUNTIME — stated once here, not repeated at every call
 * site: this component has never run in a real browser against a real
 * Stripe account. It's syntactically checked and its logic is traced
 * against the actual backend response shapes, but confirming it
 * actually mounts, collects a real card, and confirms successfully
 * needs a real npm install, a real dev server, and real Stripe
 * test-mode keys — none of which exist in the sandbox this was written
 * in.
 */
type PaymentEntityType = "job" | "load";
type Status = "idle" | "creating_intent" | "loading_stripe" | "ready" | "confirming" | "succeeded" | "requires_action" | "error";

export default function StripePaymentForm({
  entityType, entityId, amountCents, onSuccess,
}: {
  entityType: PaymentEntityType;
  entityId: string;
  amountCents: number;
  onSuccess?: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const stripeRef = useRef<StripeInstance | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const paymentElementRef = useRef<StripeElement | null>(null);
  const mountPointRef = useRef<HTMLDivElement | null>(null);

  // Both routes accept { jobId } as the body key — the freight route's
  // naming was carried over from an earlier convention; see its own
  // file's comment for why that name stuck for loads too.
  const intentPath = entityType === "job" ? "/api/stripe/job-payment-intent" : "/api/stripe/driver-payment-intent";

  async function startAuthorization() {
    setStatus("creating_intent");
    setErrorMessage(null);
    try {
      const res = await authFetch(intentPath, { method: "POST", body: JSON.stringify({ jobId: entityId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not start payment authorization (${res.status}).`);

      setStatus("loading_stripe");
      const stripe = await loadStripeClient();
      stripeRef.current = stripe;
      const elements = stripe.elements({ clientSecret: data.clientSecret, appearance: { theme: "stripe" } });
      elementsRef.current = elements;
      paymentElementRef.current = elements.create("payment");
      setStatus("ready"); // mounting itself happens in the effect below, once the DOM node this needs actually exists
    } catch (e) {
      setStatus("error");
      setErrorMessage(e instanceof NotSignedInError ? "Sign in to authorize payment." : e instanceof Error ? e.message : "Something went wrong.");
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
      // redirect: "if_required" keeps this a single-page flow whenever
      // possible — it only actually redirects the browser if the card
      // issuer's 3D Secure step requires leaving the page, which
      // confirmPayment handles on Stripe's side, not this component's.
      const result = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        redirect: "if_required",
        confirmParams: { return_url: typeof window !== "undefined" ? window.location.href : undefined },
      });
      if (result.error) {
        setStatus("error");
        setErrorMessage(result.error.message ?? "Payment could not be confirmed.");
        return;
      }
      if (result.paymentIntent?.status === "requires_action") {
        // Should be rare with redirect: "if_required" (Stripe usually
        // completes the redirect itself before returning here), but
        // handled explicitly rather than silently treated as success.
        setStatus("requires_action");
        return;
      }
      setStatus("succeeded");
      onSuccess?.();
    } catch (e) {
      setStatus("error");
      setErrorMessage(e instanceof Error ? e.message : "Payment could not be confirmed.");
    }
  }

  if (status === "succeeded") {
    return <p className="footerNote" style={{ color: "#1a7f37" }}>Payment authorized — {money(amountCents)}. Capture happens once the work is completed and approved.</p>;
  }

  return (
    <div className="panel" style={{ background: "#f7f9fc", marginTop: 10 }}>
      {status === "idle" && (
        <button className="btn btnPrimary" onClick={startAuthorization}>Authorize {money(amountCents)} with Stripe</button>
      )}
      {(status === "creating_intent" || status === "loading_stripe") && <p className="footerNote">Preparing secure payment form…</p>}
      {(status === "ready" || status === "confirming") && (
        <form onSubmit={handleConfirm}>
          <div ref={mountPointRef} style={{ minHeight: 200, marginBottom: 12 }} />
          <button className="btn btnPrimary" type="submit" disabled={status === "confirming"}>
            {status === "confirming" ? "Confirming…" : `Authorize ${money(amountCents)}`}
          </button>
        </form>
      )}
      {status === "requires_action" && <p className="footerNote">Additional verification is required by your card issuer. Please follow the prompt shown.</p>}
      {status === "error" && (
        <>
          <p className="footerNote" style={{ color: "#b3261e" }}>{errorMessage}</p>
          <button className="btn btnSecondary" onClick={() => setStatus("idle")}>Try again</button>
        </>
      )}
    </div>
  );
}

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
