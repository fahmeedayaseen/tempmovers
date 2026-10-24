"use client";

import Image from "next/image";
import { useState, type SVGProps } from "react";
import styles from "./TempMoversHero.module.css";
import { getActiveMarket } from "@/lib/active-market";

function MapPinIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 21s7-6.6 7-12a7 7 0 00-14 0c0 5.4 7 12 7 12z" />
      <path d="M12 11.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
    </svg>
  );
}

type ServiceIntent = "moving-labor" | "box-truck-delivery" | "freight";
type AuthIntent = { mode: "login" | "register"; role?: "CUSTOMER" | "MOVER" | "DRIVER"; service?: ServiceIntent };
type QuoteTab = "labor" | "boxtruck" | "freight";

const tabs: { id: QuoteTab; label: string }[] = [
  { id: "labor", label: "Moving Labor" },
  { id: "boxtruck", label: "Box Truck Delivery" },
  { id: "freight", label: "Freight" },
];

/**
 * Per the handoff's own Section 9: sample marketing numbers must be
 * verified production data or replaced before launch, never shown as if
 * real. No live stats endpoint exists yet, so this follows the same
 * NEXT_PUBLIC_DEMO_MODE gate already used for the admin dashboard's mock
 * metrics (see components/DashboardApp.tsx) rather than showing fabricated
 * figures unconditionally.
 */
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

// Same feature gate as MarketingHomepage.tsx — the multi-carrier
// quote-comparison workflow this label implies doesn't exist yet. Kept
// consistent between both hero implementations rather than letting them
// diverge on the same claim.
const FREIGHT_QUOTE_REQUESTS_ENABLED = process.env.NEXT_PUBLIC_FREIGHT_QUOTE_REQUESTS_ENABLED === "true";

export default function TempMoversHero({ onGetStarted }: { onGetStarted: (intent: AuthIntent) => void }) {
  const market = getActiveMarket();
  const [tab, setTab] = useState<QuoteTab>("labor");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const isFreight = tab === "freight";

  const freightLabel = FREIGHT_QUOTE_REQUESTS_ENABLED ? "Request Freight Quotes" : "Post a Freight Load";

  // The quote form doesn't GET-navigate to a standalone page — this app has
  // no separate /quote or /freight/quotes route to receive the query
  // string. Server-side pricing must stay authoritative (Section 8's own
  // rule), so submitting this collects intent and hands off to the real
  // registration/booking flow rather than duplicating a pricing endpoint
  // here.
  function submitQuote(e: React.FormEvent) {
    e.preventDefault();
    const service: ServiceIntent = tab === "labor" ? "moving-labor" : tab === "boxtruck" ? "box-truck-delivery" : "freight";
    onGetStarted({ mode: "register", role: "CUSTOMER", service });
  }

  return (
    <>
      <nav className={styles.nav} aria-label="Primary navigation">
        <a className={styles.brand} href="#top" aria-label="TempMovers home" onClick={(e) => e.preventDefault()}>
          <Image src="/brand/tempmovers-logo.svg" alt="TempMovers" width={260} height={52} priority />
        </a>
        <div className={styles.navLinks}>
          <a href="#services">Services</a>
          <a href="#business">For Businesses</a>
          <a href="#workers">Become a Worker</a>
          <a href="#pricing">Pricing</a>
          <a href="#help">Help Center</a>
        </div>
        <div className={styles.navActions}>
          <button className={styles.loginButton} type="button" onClick={() => onGetStarted({ mode: "login" })}>Log In</button>
          <button className={styles.primaryButton} type="button" onClick={() => onGetStarted({ mode: "register", role: "CUSTOMER", service: "moving-labor" })}>Post a Job</button>
        </div>
      </nav>

      <header className={styles.hero} id="top" aria-labelledby="hero-title">
        {/* APPROVED HERO ASSETS:
            Logo: /brand/tempmovers-logo.svg
            Backdrop: driven by config/markets.ts — currently
            /images/markets/indianapolis/hero-skyline.webp
            Do not replace these files with stock images without
            product-owner approval. Keep all text and controls in code —
            the backdrop image must never contain the city name, badge
            wording, headline, buttons, or quote form. */}
        <div className={styles.backdrop} aria-hidden="true">
          <Image
            className={styles.backdropImage}
            src={market.heroBackdrop}
            alt=""
            fill
            priority
            sizes="100vw"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        </div>
        <div className={styles.backdropOverlay} aria-hidden="true" />

        <div className={styles.heroContent}>
          <section className={styles.heroCopy}>
            <div className={styles.locationBadge}><MapPinIcon aria-hidden="true" /><span>{market.launchEyebrow}</span></div>
            <h1 id="hero-title">
              The Marketplace for<br />
              Moving Labor, Transportation<br />
              <span>&amp; Freight</span>
            </h1>
            <p className={styles.subtitle}>
              Book trusted moving help, post local delivery work, connect box trucks and carriers with freight, and manage jobs, loads, payments, and dispatch from one platform.
            </p>

            <div className={styles.stats} aria-label="TempMovers highlights">
              {DEMO_MODE ? (
                <>
                  <div><strong>10,000+</strong><span>Jobs Completed</span></div>
                  <div><strong>4.9★</strong><span>Customer Rating</span></div>
                  <div><strong>5,000+</strong><span>Vetted Professionals</span></div>
                </>
              ) : (
                <div><span className={styles.noLiveData}>Platform stats verified before public launch.</span></div>
              )}
            </div>

            <div className={styles.serviceButtons}>
              <button className={styles.servicePrimary} type="button" onClick={() => onGetStarted({ mode: "register", role: "CUSTOMER", service: "moving-labor" })}>
                <strong>Book Moving Labor</strong><span>Hourly movers</span>
              </button>
              <button type="button" onClick={() => onGetStarted({ mode: "register", role: "CUSTOMER", service: "box-truck-delivery" })}>
                <strong>Get Box Truck Delivery</strong><span>Flat-rate pricing</span>
              </button>
              <button type="button" onClick={() => onGetStarted({ mode: "register", role: "CUSTOMER", service: "freight" })}>
                <strong>{freightLabel}</strong><span>Semi trucks &amp; LTL / FTL</span>
              </button>
            </div>
          </section>

          <section className={styles.quoteCard} aria-labelledby="quote-title">
            <div className={styles.tabs} role="tablist" aria-label="Quote type">
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  className={tab === item.id ? styles.activeTab : ""}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <h2 id="quote-title">{isFreight ? "Request a Freight Quote" : "Get an Instant Quote"}</h2>
            <p>{isFreight ? "Approved carriers respond with pricing for your lane." : "Fast pricing. No hidden fees."}</p>

            <form onSubmit={submitQuote}>
              <label>
                <span>From</span>
                <input name="from" placeholder="Pickup address" autoComplete="street-address" required value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                <span>To</span>
                <input name="to" placeholder="Delivery address" autoComplete="street-address" required value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
              <div className={styles.formRow}>
                <label><span>Date</span><input name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
                <label><span>Time</span><input name="time" type="time" required value={time} onChange={(e) => setTime(e.target.value)} /></label>
              </div>
              <button className={isFreight ? styles.freightButton : styles.quoteButton} type="submit">
                {isFreight ? freightLabel : "Get Instant Quote"}
              </button>
            </form>

            <div className={styles.badges}>
              <span>✓ Instant Pricing</span><span>✓ No Hidden Fees</span><span>✓ Book in Minutes</span>
            </div>
          </section>
        </div>
      </header>
    </>
  );
}
