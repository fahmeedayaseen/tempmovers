"use client";

import { useEffect, useState } from "react";

type PublicLoad = {
  id: string;
  title: string;
  visibility: "PUBLIC_PREVIEW" | "VERIFIED_CARRIERS_ONLY" | "PREFERRED_NETWORK" | "PRIVATE_CONFIDENTIAL";
  status: string;
  originCity: string; originState: string;
  destinationCity: string; destinationState: string;
  equipmentType: string;
  pickupDate: string;
  estimatedHoursOrMiles: string;
  stopCount: number;
  liftgateRequired: boolean;
  cdlRequired: boolean;
  isLocalRoute: boolean;
  grossCarrierCents: number;
  locked: boolean;
};

const VIS_LABEL: Record<PublicLoad["visibility"], string> = {
  PUBLIC_PREVIEW: "Public preview",
  VERIFIED_CARRIERS_ONLY: "Verified carriers only",
  PREFERRED_NETWORK: "Preferred network",
  PRIVATE_CONFIDENTIAL: "Private / confidential",
};

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/**
 * Real load board — fetches /api/loads (the public, field-stripped endpoint) and
 * calls /api/loads/[id]/request when a driver requests one. No mock data here;
 * whatever renders is exactly what the backend is willing to expose publicly.
 */
export default function LoadBoard({ authToken }: { authToken?: string }) {
  const [loads, setLoads] = useState<PublicLoad[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [equipment, setEquipment] = useState<"all" | "BOX_TRUCK" | "SEMI_TRACTOR_TRAILER">("all");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (equipment !== "all") params.set("equipment", equipment);

    // Signed-in workers see the authenticated board (adds verified/preferred-network
    // loads on top of the public preview set); everyone else sees /api/loads only.
    const endpoint = authToken ? "/api/driver/loads" : "/api/loads";
    fetch(`${endpoint}?${params.toString()}`, {
      signal: controller.signal,
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(JSON.stringify(data.error));
        setLoads(data.loads ?? []);
      })
      .catch((e) => { if (e.name !== "AbortError") setError("Couldn't load the board. Try again."); })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [equipment, authToken]);

  async function requestLoad(loadId: string) {
    setMessage(null);
    if (!authToken) {
      setMessage("Sign in as a driver to request this load.");
      return;
    }
    const res = await fetch(`/api/loads/${loadId}/request`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error ?? (data.missing ? `Missing: ${data.missing.join(", ")}` : "Request denied."));
      return;
    }
    setMessage("Load assigned — full pickup details are now available in Accepted Loads.");
    setLoads((prev) => prev.filter((l) => l.id !== loadId));
  }

  return (
    <section className="panel">
      <div className="panelHead">
        <div><p className="eyebrow">LIVE LOAD BOARD</p><h3>Open box-truck &amp; semi loads</h3></div>
        <select value={equipment} onChange={(e) => setEquipment(e.target.value as typeof equipment)}>
          <option value="all">Box truck &amp; semi</option>
          <option value="BOX_TRUCK">Box truck</option>
          <option value="SEMI_TRACTOR_TRAILER">Semi</option>
        </select>
      </div>

      {message && <div className="banner" style={{ marginBottom: 14 }}>{message}</div>}
      {loading && <p className="footerNote">Loading loads…</p>}
      {error && <p className="footerNote" style={{ color: "var(--danger)" }}>{error}</p>}
      {!loading && !error && loads.length === 0 && <p className="footerNote">No open loads match these filters right now.</p>}

      <div className="list">
        {loads.map((l) => (
          <article className="jobRow" key={l.id}>
            <div className="avatar">{l.equipmentType === "BOX_TRUCK" ? "BOX" : "SEMI"}</div>
            <div>
              <strong>{l.originCity}, {l.originState} → {l.destinationCity}, {l.destinationState}</strong>
              <p>
                Pickup {new Date(l.pickupDate).toLocaleDateString()} · {l.estimatedHoursOrMiles} · {l.stopCount} stop{l.stopCount === 1 ? "" : "s"}
                {l.cdlRequired ? " · CDL required" : ""}{l.liftgateRequired ? " · Liftgate" : ""}
              </p>
              <span className="tag">{VIS_LABEL[l.visibility]}</span>
            </div>
            <div className="price">
              <strong>{money(l.grossCarrierCents)}</strong>
              <button className={l.locked ? "btn btnSecondary" : "btn btnPrimary"} onClick={() => requestLoad(l.id)}>
                {l.locked ? "Sign in to view full details" : "Request this load"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
