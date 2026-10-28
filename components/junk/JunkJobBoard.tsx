"use client";

// ---------------------------------------------------------------------------
// Junk job board — VASRUE Digital Media, 28 October 2026.
//
// The worker side of junk removal (Carl's junk spec §7–§8), inside the existing
// mover and driver dashboards rather than a portal of its own:
//   - the opt-in switch for movers and box-truck drivers (junk-only accounts
//     are always on);
//   - open junk jobs this worker can take, with what their seat pays;
//   - their own junk seats: address and access notes once taken, check in and
//     check out, before/after photos and the dump receipt.
// Every action goes through the same routes as moving work; the job board adds
// no money logic of its own.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/client-auth";
import {
  JUNK_ITEMS, JUNK_LOCATION_LABELS, JUNK_SPECIAL_ITEMS, JUNK_TIER_INFO,
  type JunkItemCode, type JunkLocationCode, type JunkSpecialItemCode, type JunkVolumeTierCode,
} from "@/lib/junk/pricing";

type Seat = "HAULER" | "HELPER";
type Capability = { workerType: string; seat: Seat | null; junkOnly: boolean; junkRemovalEnabled: boolean; canTakeJunkJobs: boolean };
type DetailSummary = {
  pricingMode: "VOLUME" | "ITEMS"; volumeTier: JunkVolumeTierCode | null; items: { code: JunkItemCode; quantity: number }[] | null;
  itemLocation: JunkLocationCode; hasHeavyItems: boolean; specialItems: JunkSpecialItemCode[]; helpersRequired: number;
};
type OpenJob = {
  id: string; title: string; startsAt: string; market: { name: string; state: string } | null;
  junkRemovalDetail: (DetailSummary & { haulerShareCents: number; helperShareCents: number }) | null;
  junkSeats?: { haulerOpen: boolean; helpersOpen: number };
};
type MyJob = {
  assignmentId: string; seat: Seat; status: string; shareCents: number;
  payout: { status: string; netPayoutCents: number } | null;
  job: { id: string; title: string; status: string; startsAt: string; accessNotes: string | null; address: { line1: string; line2: string | null; city: string; state: string; postalCode: string } };
  detail: (DetailSummary & { itemNotes: string | null; customerPhotoUrls: string[]; proof: { before: number; after: number; dumpReceipt: boolean } }) | null;
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function describe(d: DetailSummary) {
  const what = d.pricingMode === "VOLUME" && d.volumeTier
    ? JUNK_TIER_INFO[d.volumeTier].label
    : (d.items ?? []).map((i) => `${JUNK_ITEMS[i.code]?.label ?? i.code}${i.quantity > 1 ? ` × ${i.quantity}` : ""}`).join(", ");
  const extras = [JUNK_LOCATION_LABELS[d.itemLocation], d.hasHeavyItems ? "heavy items" : null, ...d.specialItems.map((s) => JUNK_SPECIAL_ITEMS[s])].filter(Boolean);
  return `${what} · ${extras.join(" · ")}`;
}

function currentPosition(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("This device can't share its location.")); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => reject(new Error("Allow location access to check in and out.")),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
}

export default function JunkJobBoard() {
  const [capability, setCapability] = useState<Capability | null>(null);
  const [mine, setMine] = useState<MyJob[]>([]);
  const [open, setOpen] = useState<OpenJob[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch("/api/junk/my-jobs");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Couldn't load junk jobs.");
      setCapability(data.capability);
      setMine(data.jobs);
      if (data.capability?.canTakeJunkJobs) {
        const feed = await authFetch("/api/jobs?service=junk");
        const feedData = await feed.json().catch(() => ({}));
        setOpen(feed.ok ? feedData.jobs ?? [] : []);
      } else {
        setOpen([]);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't load junk jobs.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(id: string, action: () => Promise<Response>, done: string) {
    setBusyId(id); setMessage(null);
    try {
      const res = await action();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "That didn't work. Try again.");
      setMessage(done);
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function uploadProof(a: MyJob, kind: "BEFORE" | "AFTER" | "DUMP_RECEIPT", file: File) {
    await run(a.assignmentId, async () => {
      const presign = await authFetch("/api/junk/uploads/presign", {
        method: "POST",
        body: JSON.stringify({ purpose: kind, assignmentId: a.assignmentId, contentType: file.type, contentLength: file.size }),
      });
      if (!presign.ok) return presign;
      const { uploadUrl, key } = await presign.json();
      const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!put.ok) throw new Error("The upload didn't go through. Try again.");
      return authFetch(`/api/junk/assignments/${a.assignmentId}/proof`, { method: "POST", body: JSON.stringify({ kind, key }) });
    }, kind === "DUMP_RECEIPT" ? "Dump receipt saved." : "Photo saved.");
  }

  if (!capability) return null;
  if (!capability.seat) return null; // semi drivers never see junk work

  return (
    <section className="panel">
      <div className="panelHead">
        <div><p className="eyebrow">JUNK REMOVAL</p><h3>Junk jobs</h3></div>
        {!capability.junkOnly && (
          <label className="footerNote" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={capability.junkRemovalEnabled} disabled={busyId === "capability"}
              onChange={(e) => run("capability", () => authFetch("/api/junk/capability", { method: "PATCH", body: JSON.stringify({ enabled: e.target.checked }) }),
                e.target.checked ? "Junk jobs switched on." : "Junk jobs switched off.")} />
            Take junk removal jobs
          </label>
        )}
      </div>
      <p className="footerNote" style={{ marginTop: 0 }}>
        {capability.seat === "HAULER" ? "You take the hauler seat: you bring the truck and cover your own dump fees from your share." : "You take a helper seat: loading and carrying alongside the hauler."}
        {" "}Pay is a flat amount per job, shown before you take it.
      </p>
      {message && <div className="banner">{message}</div>}

      {mine.length > 0 && (
        <>
          <h4>My junk jobs</h4>
          {mine.map((a) => (
            <div key={a.assignmentId} className="card" style={{ padding: 14, marginBottom: 10 }}>
              <strong>{a.job.title}</strong> <span className="status info">{a.status.replace("_", " ").toLowerCase()}</span>
              <p className="footerNote" style={{ margin: "6px 0" }}>
                {new Date(a.job.startsAt).toLocaleString()} · {a.job.address.line1}{a.job.address.line2 ? `, ${a.job.address.line2}` : ""}, {a.job.address.city} {a.job.address.postalCode}<br />
                {a.detail ? describe(a.detail) : ""}
                {a.job.accessNotes && <><br />Access: {a.job.accessNotes}</>}
                {a.detail?.itemNotes && <><br />Notes: {a.detail.itemNotes}</>}
                <br />Your {a.seat.toLowerCase()} pay: <strong>{money(a.shareCents)}</strong>{a.payout ? ` · payout ${a.payout.status.toLowerCase()}` : ""}
              </p>
              {a.detail && a.detail.customerPhotoUrls.length > 0 && (
                <p className="footerNote">Customer photos: {a.detail.customerPhotoUrls.map((u, i) => <a key={u} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>photo {i + 1}</a>)}</p>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                {a.status === "ACCEPTED" && (
                  <button className="btn btnPrimary" disabled={busyId === a.assignmentId}
                    onClick={() => run(a.assignmentId, async () => authFetch(`/api/assignments/${a.assignmentId}/check-in`, { method: "POST", body: JSON.stringify(await currentPosition()) }), "Checked in.")}>
                    Check in
                  </button>
                )}
                {a.status === "CHECKED_IN" && (
                  <button className="btn btnPrimary" disabled={busyId === a.assignmentId}
                    onClick={() => run(a.assignmentId, async () => authFetch(`/api/assignments/${a.assignmentId}/check-out`, { method: "POST", body: JSON.stringify(await currentPosition()) }), "Checked out. The customer will approve the job.")}>
                    Check out
                  </button>
                )}
                {["CHECKED_IN", "CHECKED_OUT", "APPROVED"].includes(a.status) && a.detail && (
                  <>
                    {(["BEFORE", "AFTER"] as const).map((kind) => (
                      <label key={kind} className="btn btnSecondary" style={{ cursor: "pointer" }}>
                        {kind === "BEFORE" ? `Before photos (${a.detail!.proof.before})` : `After photos (${a.detail!.proof.after})`}
                        <input type="file" accept="image/jpeg,image/png,image/webp,image/heic" hidden
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadProof(a, kind, f); e.target.value = ""; }} />
                      </label>
                    ))}
                    {a.seat === "HAULER" && (
                      <label className="btn btnSecondary" style={{ cursor: "pointer" }}>
                        {a.detail.proof.dumpReceipt ? "Dump receipt ✓" : "Dump receipt"}
                        <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" hidden
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadProof(a, "DUMP_RECEIPT", f); e.target.value = ""; }} />
                      </label>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      <h4>Open junk jobs</h4>
      {!capability.canTakeJunkJobs && <p className="footerNote">Switch on junk removal jobs above to see them here.</p>}
      {capability.canTakeJunkJobs && open.length === 0 && <p className="footerNote">No open junk jobs for your seat right now.</p>}
      {open.length > 0 && (
        <table className="table">
          <thead><tr><th>Job</th><th>When</th><th>What</th><th>Your pay</th><th></th></tr></thead>
          <tbody>
            {open.map((j) => j.junkRemovalDetail && (
              <tr key={j.id}>
                <td>{j.title}<div className="footerNote">{j.market ? `${j.market.name}, ${j.market.state}` : ""}</div></td>
                <td>{new Date(j.startsAt).toLocaleString()}</td>
                <td>{describe(j.junkRemovalDetail)}<div className="footerNote">Crew: hauler{j.junkRemovalDetail.helpersRequired > 0 ? ` + ${j.junkRemovalDetail.helpersRequired} helper${j.junkRemovalDetail.helpersRequired > 1 ? "s" : ""}` : ""}</div></td>
                <td><strong>{money(capability.seat === "HAULER" ? j.junkRemovalDetail.haulerShareCents : j.junkRemovalDetail.helperShareCents)}</strong></td>
                <td>
                  <button className="btn btnPrimary" disabled={busyId === j.id}
                    onClick={() => run(j.id, () => authFetch(`/api/jobs/${j.id}/assignments`, { method: "POST" }), "You're on this job. The address is now in My junk jobs.")}>
                    Take this job
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
