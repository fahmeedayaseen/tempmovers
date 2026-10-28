"use client";

// ---------------------------------------------------------------------------
// Junk removal booking — VASRUE Digital Media, 28 October 2026.
//
// Carl's junk spec §4: a three-step flow of its own, not the mover-hour form.
//   1. What's going   — truckload tier or item list, location, heavy items,
//                        special items and the "can't take" list, optional
//                        photos, pickup address and time.
//   2. Crew & price   — the instant all-in quote from the market's pricing.
//   3. Review & pay   — creates the booking, then authorises the card through
//                        the same StripePaymentForm every other booking uses.
// The browser never computes a price it sends anywhere: the quote comes from
// POST /api/junk/quote and the booking route recomputes it on the server.
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { authFetch, NotSignedInError, type StoredUser } from "@/lib/client-auth";
import StripePaymentForm from "@/components/StripePaymentForm";
import {
  JUNK_ITEMS, JUNK_ITEM_CATEGORIES, JUNK_LOCATION_LABELS, JUNK_PROHIBITED_ITEMS, JUNK_SPECIAL_ITEMS, JUNK_TIER_INFO,
  JUNK_VOLUME_TIERS, MAX_JUNK_ITEM_QUANTITY,
  type JunkItemCategoryCode, type JunkItemCode, type JunkLocationCode, type JunkPricingModeCode, type JunkSpecialItemCode,
  type JunkVolumeTierCode, type JunkQuoteLine,
} from "@/lib/junk/pricing";

type PublicQuote = {
  pricingMode: JunkPricingModeCode;
  servicePriceCents: number;
  surchargesCents: number;
  allInCents: number;
  helpersRequired: number;
  crewSize: number;
  bookingProtectionFeeCents: number;
  totalCents: number;
  estimatedHours: number;
  lines: JunkQuoteLine[];
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const toggle = <T,>(set: Set<T>, value: T) => {
  const next = new Set(set);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
};

export default function JunkBookingWizard({ user }: { user: StoredUser }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 — what's going
  const [pricingMode, setPricingMode] = useState<JunkPricingModeCode>("VOLUME");
  const [volumeTier, setVolumeTier] = useState<JunkVolumeTierCode | null>(null);
  const [items, setItems] = useState<Partial<Record<JunkItemCode, number>>>({});
  const [categories, setCategories] = useState<Set<JunkItemCategoryCode>>(new Set());
  const [itemNotes, setItemNotes] = useState("");
  const [itemLocation, setItemLocation] = useState<JunkLocationCode>("CURBSIDE");
  const [hasHeavyItems, setHasHeavyItems] = useState(false);
  const [specialItems, setSpecialItems] = useState<Set<JunkSpecialItemCode>>(new Set());
  const [photos, setPhotos] = useState<{ key: string; name: string }[]>([]);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [line1, setLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("IN");
  const [postalCode, setPostalCode] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [accessNotes, setAccessNotes] = useState("");

  // Step 2 — quote
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 3 — booking
  const [booked, setBooked] = useState<{ jobId: string; totalCents: number } | null>(null);
  const [authorized, setAuthorized] = useState(false);

  const itemList = useMemo(
    () => (Object.entries(items) as [JunkItemCode, number][]).filter(([, q]) => q > 0).map(([code, quantity]) => ({ code, quantity })),
    [items],
  );

  const details = {
    pricingMode,
    volumeTier: pricingMode === "VOLUME" ? volumeTier : null,
    items: pricingMode === "ITEMS" ? itemList : null,
    itemCategories: [...categories],
    specialItems: [...specialItems],
    itemLocation,
    hasHeavyItems,
  };

  if (user.role !== "CUSTOMER") {
    return (
      <div className="panel" style={{ maxWidth: 640, margin: "60px auto" }}>
        <p className="eyebrow">JUNK REMOVAL</p>
        <h2>Customer accounts book junk removal</h2>
        <p className="footerNote">You're signed in as a {user.role.toLowerCase()}. Junk jobs for your crew appear in your dashboard.</p>
        <a className="btn btnPrimary" href="/">Go to my dashboard</a>
      </div>
    );
  }

  function stepOneProblem(): string | null {
    if (pricingMode === "VOLUME" && !volumeTier) return "Choose roughly how much there is to haul.";
    if (pricingMode === "ITEMS" && itemList.length === 0) return "Add at least one item.";
    if (!line1.trim() || !city.trim() || state.trim().length !== 2 || !/^\d{5}$/.test(postalCode.trim())) return "Enter the full pickup address, with a 5-digit ZIP.";
    if (!startsAt) return "Choose a pickup date and time.";
    if (new Date(startsAt).getTime() < Date.now() + 60 * 60 * 1000) return "Choose a pickup time at least an hour from now.";
    return null;
  }

  async function getQuote() {
    const problem = stepOneProblem();
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/junk/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postalCode: postalCode.trim(), details }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "We couldn't price that. Check the details and try again.");
      setQuote(data.quote);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function addPhoto(file: File) {
    setPhotoBusy(true); setPhotoMessage(null);
    try {
      const res = await authFetch("/api/junk/uploads/presign", {
        method: "POST",
        body: JSON.stringify({ purpose: "BOOKING_PHOTO", contentType: file.type, contentLength: file.size }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503) { setPhotoMessage("Photo upload isn't available yet. You can book without photos."); return; }
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "That photo couldn't be uploaded.");
      const put = await fetch(data.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!put.ok) throw new Error("That photo couldn't be uploaded.");
      setPhotos((p) => [...p, { key: data.key, name: file.name }]);
    } catch (e) {
      setPhotoMessage(e instanceof NotSignedInError ? "Sign in again to add photos." : e instanceof Error ? e.message : "That photo couldn't be uploaded.");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function book() {
    setBusy(true); setError(null);
    try {
      const addressRes = await authFetch("/api/addresses", {
        method: "POST",
        body: JSON.stringify({ line1: line1.trim(), city: city.trim(), state: state.trim().toUpperCase(), postalCode: postalCode.trim() }),
      });
      const addressData = await addressRes.json().catch(() => ({}));
      if (!addressRes.ok) throw new Error(typeof addressData.error === "string" ? addressData.error : "We couldn't save that address.");

      const res = await authFetch("/api/junk/bookings", {
        method: "POST",
        body: JSON.stringify({
          addressId: addressData.address.id,
          startsAt: new Date(startsAt).toISOString(),
          accessNotes: accessNotes.trim() || undefined,
          itemNotes: itemNotes.trim() || undefined,
          photoKeys: photos.map((p) => p.key),
          details,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "We couldn't book that. Check the details and try again.");
      setBooked({ jobId: data.job.id, totalCents: data.job.estimatedTotalCents });
      setQuote(data.quote);
    } catch (e) {
      setError(e instanceof NotSignedInError ? "Sign in again to book." : e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const stepLabel = (n: 1 | 2 | 3, label: string) => (
    <button className={step === n ? "active" : ""} disabled>{n}. {label}</button>
  );

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "32px 16px 60px" }}>
      <p className="eyebrow">JUNK REMOVAL · INDIANAPOLIS</p>
      <h1 style={{ margin: "0 0 6px" }}>Book junk removal</h1>
      <p className="footerNote" style={{ marginTop: 0 }}>One all-in price for hauling, labor and disposal. Your card is authorised when you book and charged only once the job is done.</p>
      <div className="tabs">{stepLabel(1, "What's going")}{stepLabel(2, "Crew & price")}{stepLabel(3, "Review & pay")}</div>

      {step === 1 && (
        <div className="panel">
          <div className="tabs">
            <button className={pricingMode === "VOLUME" ? "active" : ""} onClick={() => setPricingMode("VOLUME")}>Price by truckload</button>
            <button className={pricingMode === "ITEMS" ? "active" : ""} onClick={() => setPricingMode("ITEMS")}>Price by item</button>
          </div>

          {pricingMode === "VOLUME" ? (
            <>
              <h3 style={{ marginTop: 0 }}>Roughly how much is there?</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 10 }}>
                {JUNK_VOLUME_TIERS.map((t) => (
                  <label key={t} className="card" style={{ padding: 12, cursor: "pointer", borderColor: volumeTier === t ? "var(--blue)" : undefined }}>
                    <input type="radio" name="tier" checked={volumeTier === t} onChange={() => setVolumeTier(t)} style={{ marginRight: 8 }} />
                    <strong>{JUNK_TIER_INFO[t].label}</strong>
                    <div className="footerNote">{JUNK_TIER_INFO[t].guide}</div>
                  </label>
                ))}
              </div>
              <h3>What's being removed?</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                {(Object.keys(JUNK_ITEM_CATEGORIES) as JunkItemCategoryCode[]).map((c) => (
                  <label key={c}><input type="checkbox" checked={categories.has(c)} onChange={() => setCategories((s) => toggle(s, c))} /> {JUNK_ITEM_CATEGORIES[c]}</label>
                ))}
              </div>
            </>
          ) : (
            <>
              <h3 style={{ marginTop: 0 }}>Which items?</h3>
              <table className="table">
                <tbody>
                  {(Object.keys(JUNK_ITEMS) as JunkItemCode[]).map((code) => {
                    const q = items[code] ?? 0;
                    const set = (n: number) => setItems((s) => ({ ...s, [code]: Math.max(0, Math.min(MAX_JUNK_ITEM_QUANTITY, n)) }));
                    return (
                      <tr key={code}>
                        <td>{JUNK_ITEMS[code].label}</td>
                        <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                          <button className="btn btnSecondary" onClick={() => set(q - 1)} aria-label={`Fewer ${JUNK_ITEMS[code].label}`}>−</button>
                          <strong style={{ display: "inline-block", width: 32, textAlign: "center" }}>{q}</strong>
                          <button className="btn btnSecondary" onClick={() => set(q + 1)} aria-label={`More ${JUNK_ITEMS[code].label}`}>+</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}

          <div className="field" style={{ marginTop: 14 }}>
            <label>Anything we should know about the items? (optional)</label>
            <textarea rows={2} value={itemNotes} onChange={(e) => setItemNotes(e.target.value)} maxLength={1000} />
          </div>

          <h3>Where are the items?</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            {(Object.keys(JUNK_LOCATION_LABELS) as JunkLocationCode[]).map((l) => (
              <label key={l}><input type="radio" name="loc" checked={itemLocation === l} onChange={() => setItemLocation(l)} /> {JUNK_LOCATION_LABELS[l]}</label>
            ))}
          </div>
          <p style={{ marginBottom: 0 }}>
            <label><input type="checkbox" checked={hasHeavyItems} onChange={(e) => setHasHeavyItems(e.target.checked)} /> There are heavy or bulky items (appliances, a safe, a piano, a hot tub)</label>
          </p>

          <h3>Special items</h3>
          <p className="footerNote" style={{ marginTop: 0 }}>These need special handling or disposal and may add a fee.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 6 }}>
            {(Object.keys(JUNK_SPECIAL_ITEMS) as JunkSpecialItemCode[]).map((s) => (
              <label key={s}><input type="checkbox" checked={specialItems.has(s)} onChange={() => setSpecialItems((x) => toggle(x, s))} /> {JUNK_SPECIAL_ITEMS[s]}</label>
            ))}
          </div>
          <div className="banner" style={{ marginTop: 14 }}>
            <strong>We can't take:</strong> {JUNK_PROHIBITED_ITEMS.join(", ")}. Your city or county household hazardous waste service can take these safely.
          </div>

          <h3>Photos (optional)</h3>
          <input type="file" accept="image/jpeg,image/png,image/webp,image/heic" disabled={photoBusy || photos.length >= 12}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void addPhoto(f); e.target.value = ""; }} />
          {photos.length > 0 && <p className="footerNote">{photos.length} photo(s) added: {photos.map((p) => p.name).join(", ")}</p>}
          {photoMessage && <p className="footerNote">{photoMessage}</p>}

          <h3>Pickup</h3>
          <div className="grid4" style={{ gridTemplateColumns: "2fr 1fr 70px 110px" }}>
            <div className="field"><label>Street address</label><input value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="123 Main St" /></div>
            <div className="field"><label>City</label><input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Indianapolis" /></div>
            <div className="field"><label>State</label><input value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} /></div>
            <div className="field"><label>ZIP</label><input value={postalCode} inputMode="numeric" maxLength={5} onChange={(e) => setPostalCode(e.target.value)} placeholder="46204" /></div>
          </div>
          <div className="grid4" style={{ gridTemplateColumns: "1fr 2fr", marginTop: 10 }}>
            <div className="field"><label>Date &amp; time</label><input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></div>
            <div className="field"><label>Access notes (gate code, parking, where to find the items)</label><input value={accessNotes} maxLength={1000} onChange={(e) => setAccessNotes(e.target.value)} /></div>
          </div>

          {error && <p className="footerNote" style={{ color: "#b42318" }}>{error}</p>}
          <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between" }}>
            <a className="btn btnSecondary" href="/">Cancel</a>
            <button className="btn btnPrimary" disabled={busy} onClick={getQuote}>{busy ? "Pricing…" : "See my price"}</button>
          </div>
        </div>
      )}

      {step === 2 && quote && (
        <div className="dashboardGrid" style={{ marginTop: 0 }}>
          <section className="panel">
            <p className="eyebrow">YOUR CREW</p>
            <h3 style={{ marginTop: 0 }}>{quote.crewSize === 1 ? "One hauler with a truck" : `A hauler with a truck, plus ${quote.helpersRequired} helper${quote.helpersRequired > 1 ? "s" : ""}`}</h3>
            <p className="footerNote">About {quote.estimatedHours} hour{quote.estimatedHours === 1 ? "" : "s"} on site. Vetted, background-checked crew from the TempMovers network.</p>
            <p className="footerNote">One all-in price: loading, hauling and disposal are included. There is no separate dump fee.</p>
          </section>
          <aside className="panel">
            <p className="eyebrow">YOUR PRICE</p>
            <div className="quote">
              {quote.lines.map((l) => <div className="quoteRow" key={l.label}><span>{l.label}</span><strong>{money(l.cents)}</strong></div>)}
              <div className="quoteRow total"><span>Total</span><strong>{money(quote.totalCents)}</strong></div>
            </div>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between" }}>
              <button className="btn btnSecondary" onClick={() => setStep(1)}>Back</button>
              <button className="btn btnPrimary" onClick={() => { setError(null); setStep(3); }}>Continue</button>
            </div>
          </aside>
        </div>
      )}

      {step === 3 && quote && (
        <div className="dashboardGrid" style={{ marginTop: 0 }}>
          <section className="panel">
            <p className="eyebrow">REVIEW</p>
            <h3 style={{ marginTop: 0 }}>{pricingMode === "VOLUME" && volumeTier ? JUNK_TIER_INFO[volumeTier].label : `${itemList.reduce((n, i) => n + i.quantity, 0)} item(s)`}</h3>
            <p className="footerNote">
              {line1}, {city}, {state} {postalCode}<br />
              {startsAt ? new Date(startsAt).toLocaleString() : ""} · {JUNK_LOCATION_LABELS[itemLocation]}{hasHeavyItems ? " · heavy items" : ""}
              {specialItems.size > 0 && <><br />Special items: {[...specialItems].map((s) => JUNK_SPECIAL_ITEMS[s]).join(", ")}</>}
              {photos.length > 0 && <><br />{photos.length} photo(s)</>}
            </p>
            {!booked && <button className="btn btnSecondary" onClick={() => setStep(1)}>Edit details</button>}
          </section>
          <aside className="panel">
            <p className="eyebrow">PAYMENT</p>
            <div className="quote"><div className="quoteRow total"><span>Total</span><strong>{money(booked?.totalCents ?? quote.totalCents)}</strong></div></div>
            {!booked && (
              <>
                <p className="footerNote">Booking authorises this amount on your card. You're charged once the crew has finished and you've approved the job.</p>
                {error && <p className="footerNote" style={{ color: "#b42318" }}>{error}</p>}
                <button className="btn btnPrimary" style={{ width: "100%" }} disabled={busy} onClick={book}>{busy ? "Booking…" : "Confirm booking"}</button>
              </>
            )}
            {booked && !authorized && (
              <div style={{ marginTop: 14 }}>
                <StripePaymentForm entityType="job" entityId={booked.jobId} amountCents={booked.totalCents} onSuccess={() => setAuthorized(true)} />
              </div>
            )}
            {authorized && (
              <div className="banner" style={{ marginTop: 14 }}>
                <strong>You're booked.</strong> Your card is authorised for {money(booked!.totalCents)}. We'll match your crew and you can follow the job from your dashboard.
                <div style={{ marginTop: 10 }}><a className="btn btnPrimary" href="/">Go to my dashboard</a></div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
