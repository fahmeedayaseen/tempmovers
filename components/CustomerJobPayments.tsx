"use client";

// ---------------------------------------------------------------------------
// Customer payment panel — VASRUE Digital Media, 29 October 2026.
//
// Pay before dispatch, customer side (payment spec §8): what was collected and
// when, the disposal set-aside on junk, receipts and refunds, any change the
// crew has asked for (approve and pay it, or decline), and cancel-before-
// dispatch with a full refund. Reads GET /api/jobs/[id]/ledger and the
// change-order routes; it computes no amounts of its own.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/client-auth";
import StripePaymentForm from "./StripePaymentForm";

type Ledger = {
  payment: { status: string; scopeCents: number; collectedCents: number; refundedCents: number; collectedWhen: string };
  changeOrders: { id: string; version: number; kind: string; status: string; deltaCents: number; lines: { label: string; cents: number }[]; reason: string }[];
  receipts: { amountCents: number; brand: string | null; last4: string | null; receiptUrl: string | null; at: string }[];
  refunds: { amountCents: number; status: string; reason: string; at: string }[];
  disposal: { estimatedCents: number; actualCents: number | null; status: string; rule: string } | null;
};

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const STATUS_TEXT: Record<string, string> = {
  PAID: "Paid in full", PAYMENT_PENDING: "Payment needed", ACTION_REQUIRED: "Finish confirming your payment", PROCESSING: "Payment processing",
  FAILED: "Payment failed, please try again", REFUNDED: "Refunded", DISPUTED: "Payment disputed", CREDIT_TERMS: "On account",
};
const STARTED = ["IN_PROGRESS", "COMPLETED", "CANCELED", "REVIEW_PENDING", "DISPUTED"];

export default function CustomerJobPayments({ jobId, jobStatus, onChanged }: { jobId: string; jobStatus: string; onChanged?: () => void }) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await authFetch(`/api/jobs/${jobId}/ledger`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(typeof data.error === "string" ? data.error : "Couldn't load the payment details."); return; }
    setLedger(data);
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  async function decline(id: string) {
    setBusy(true); setNote(null);
    const res = await authFetch(`/api/change-orders/${id}/decline`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setNote(res.ok ? "Declined. The crew will do only what you booked." : typeof data.error === "string" ? data.error : "Couldn't decline.");
    setBusy(false);
    await load();
  }

  async function cancel() {
    setBusy(true); setNote(null);
    const res = await authFetch(`/api/jobs/${jobId}/cancel`, { method: "POST", body: JSON.stringify({ reason: cancelReason }) });
    const data = await res.json().catch(() => ({}));
    setNote(res.ok ? `Booking canceled. ${data.refundedCents > 0 ? `${money(data.refundedCents)} is on its way back to your card.` : ""}` : typeof data.error === "string" ? data.error : "Couldn't cancel.");
    setBusy(false);
    await load();
    onChanged?.();
  }

  if (error) return <p className="footerNote">{error}</p>;
  if (!ledger) return <p className="footerNote">Loading payment details…</p>;
  const pending = ledger.changeOrders.filter((c) => c.status === "PROPOSED" || c.status === "ACCEPTED");

  return (
    <div className="panel" style={{ background: "#f7f9fc" }}>
      <p className="eyebrow">PAYMENT</p>
      <p style={{ margin: "0 0 6px" }}><strong>{STATUS_TEXT[ledger.payment.status] ?? ledger.payment.status}</strong> · {money(ledger.payment.collectedCents)} paid{ledger.payment.refundedCents > 0 ? `, ${money(ledger.payment.refundedCents)} refunded` : ""}</p>
      <p className="footerNote" style={{ marginTop: 0 }}>{ledger.payment.collectedWhen}.</p>
      {ledger.disposal && (
        <p className="footerNote">Disposal: {money(ledger.disposal.estimatedCents)} set aside{ledger.disposal.actualCents != null ? `, the dump cost ${money(ledger.disposal.actualCents)}` : ""}. {ledger.disposal.rule}</p>
      )}

      {pending.length > 0 && (
        <div style={{ margin: "10px 0" }}>
          <p className="eyebrow">YOUR CREW ASKED TO ADD</p>
          {pending.map((c) => (
            <div key={c.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
              <strong>{c.reason}</strong> — {money(c.deltaCents)}
              <ul className="footerNote" style={{ margin: "4px 0 8px", paddingLeft: 18 }}>{c.lines.map((l) => <li key={l.label}>{l.label}: {money(l.cents)}</li>)}</ul>
              <p className="footerNote" style={{ margin: "0 0 8px" }}>The added work starts only after this is paid. Say no and the crew does just what you booked.</p>
              {payingId === c.id ? (
                <StripePaymentForm entityType="changeOrder" entityId={c.id} amountCents={c.deltaCents} onSuccess={() => { setPayingId(null); setNote("Paid. Your crew can go ahead."); void load(); }} />
              ) : (
                <>
                  <button className="btn btnPrimary" style={{ marginRight: 6 }} disabled={busy} onClick={() => setPayingId(c.id)}>Approve and pay {money(c.deltaCents)}</button>
                  <button className="btn btnSecondary" disabled={busy} onClick={() => decline(c.id)}>Decline</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {ledger.receipts.length > 0 && (
        <p className="footerNote">Receipts: {ledger.receipts.map((r, i) => (
          <span key={i} style={{ marginRight: 10 }}>{money(r.amountCents)}{r.last4 ? ` (${r.brand ?? "card"} ···${r.last4})` : ""}{r.receiptUrl && <> · <a href={r.receiptUrl} target="_blank" rel="noreferrer">receipt</a></>}</span>
        ))}</p>
      )}
      {ledger.refunds.length > 0 && (
        <p className="footerNote">Refunds: {ledger.refunds.map((r, i) => <span key={i} style={{ marginRight: 10 }}>{money(r.amountCents)} ({r.status.toLowerCase()})</span>)}</p>
      )}

      {!STARTED.includes(jobStatus) && (
        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input aria-label="Reason for canceling" placeholder="Reason for canceling" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} style={{ minWidth: 220 }} />
          <button className="btn btnSecondary" disabled={busy || cancelReason.trim().length < 3} onClick={cancel}>Cancel booking and refund</button>
        </div>
      )}
      {note && <p className="footerNote" style={{ marginTop: 8 }}>{note}</p>}
    </div>
  );
}
