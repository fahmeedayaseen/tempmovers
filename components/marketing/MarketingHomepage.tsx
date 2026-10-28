"use client";

import "./marketing.css";
import TempMoversHero from "./TempMoversHero";

type AuthIntent = { mode: "login" | "register"; role?: "CUSTOMER" | "MOVER" | "DRIVER"; service?: "moving-labor" | "box-truck-delivery" | "freight" };

function Icon({ path, size = 20 }: { path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  truck: "M1 3h13v13H1z M14 8h4l4 4v4h-8V8z M5.5 21a2.5 2.5 0 100-5 2.5 2.5 0 000 5z M18.5 21a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  shield: "M12 2 4 5v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V5z",
  users: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9-6.2-3.3-6.2 3.3 1.2-6.9-5-4.9 6.9-1z",
  boxes: "M20 12v9H4v-9 M2 7l10-5 10 5-10 5z M12 22V12",
  route: "M4 19h4l3-14 3 14h4 M2 19h20",
  cart: "M6 6h15l-1.5 9h-12z M6 6L5 3H2 M9 20a1 1 0 100-2 1 1 0 000 2z M18 20a1 1 0 100-2 1 1 0 000 2z",
  building: "M4 21V7l8-4 8 4v14 M9 9h1 M9 13h1 M9 17h1 M14 9h1 M14 13h1 M14 17h1",
  check: "M20 6 9 17l-5-5",
  clock: "M12 2a10 10 0 100 20 10 10 0 000-20z M12 6v6l4 2",
  tag: "M20.6 13.4 12 22l-9-9L11.6 4H20.6z M15.5 7.5h.01",
  card: "M2 7h20v13H2z M2 11h20",
  headset: "M4 13v-1a8 8 0 0116 0v1 M2 16v-2a2 2 0 012-2h1v6H4a2 2 0 01-2-2z M22 16v-2a2 2 0 00-2-2h-1v6h1a2 2 0 002-2z",
  pin: "M12 21s7-6.6 7-12a7 7 0 00-14 0c0 5.4 7 12 7 12z M12 11.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  chevron: "M9 18l6-6-6-6",
  send: "M22 2 11 13 M22 2l-7 20-4-9-9-4z",
};

const SERVICES = [
  { icon: ICONS.users, tone: "blue", title: "Moving Labor", copy: "Vetted movers for residential and office loading, unloading, and full moves.", href: "#" },
  { icon: ICONS.truck, tone: "violet", title: "Box Truck Delivery", copy: "Furniture, appliances, and freight delivered with a driver and truck in one flat rate.", href: "#" },
  { icon: ICONS.route, tone: "teal", title: "Freight Shipping", copy: "LTL and FTL freight, pallets, and equipment moved by approved carriers.", href: "#" },
  { icon: ICONS.boxes, tone: "orange", title: "Junk Removal", copy: "Cleanouts, hauling, and responsible disposal, booked the same way as a move.", href: "/book/junk" }, // Junk removal — VASRUE Digital Media, 28 Oct 2026: live route.
  { icon: ICONS.cart, tone: "violet", title: "Store Pickup & Delivery", copy: "Home Depot, Lowe's, Costco, and other big-box runs handled end to end.", href: "#" },
  { icon: ICONS.building, tone: "blue", title: "Business Solutions", copy: "Recurring jobs, consolidated invoicing, and a dedicated account contact.", href: "#" },
];

const WAYPOINTS = [
  { label: "Book", title: "Tell us what's moving", copy: "Pickup, drop-off, date, and what you need — instant pricing, no calls." },
  { label: "Match", title: "We match the right crew", copy: "A vetted mover, box truck, or carrier accepts based on your route and timing." },
  { label: "Move", title: "Track it in real time", copy: "See who's assigned and where they are, from check-in to check-out." },
  { label: "Deliver", title: "Pay only when it's done", copy: "Your card is charged once the job is confirmed complete — no upfront risk." },
];

const TRUST_ITEMS = [
  { icon: ICONS.shield, title: "Vetted Professionals", copy: "Background checked & verified" },
  { icon: ICONS.tag, title: "Upfront Pricing", copy: "Transparent quotes, no surprises" },
  { icon: ICONS.pin, title: "Real-Time Tracking", copy: "Track your job every step" },
  { icon: ICONS.card, title: "Secure Payments", copy: "Safe, fast, and protected" },
  { icon: ICONS.headset, title: "24/7 Support", copy: "We're here when you need us" },
];

const TESTIMONIALS = [
  { name: "Priya M.", context: "Apartment move, Broad Ripple", quote: "Booked two movers for a Saturday morning and they showed up early. Everything was wrapped and loaded with more care than I expected for the price." },
  { name: "Derek W.", context: "Warehouse restock, Fishers", quote: "We use the box truck service for weekly store runs now. Flat rate every time, so our invoicing finally makes sense." },
  { name: "Angela R.", context: "Office relocation, Downtown Indy", quote: "Coordinated a 12-desk office move through the business account. One invoice, one point of contact, no chasing anyone down." },
];

const SERVICE_AREAS = ["Indianapolis", "Carmel", "Fishers", "Noblesville", "Greenwood", "Avon", "Zionsville", "Westfield"];

function ToneIcon({ path, tone }: { path: string; tone: string }) {
  const tones: Record<string, { bg: string; color: string }> = {
    blue: { bg: "var(--tm-blue-dim)", color: "var(--tm-blue)" },
    violet: { bg: "var(--tm-violet-dim)", color: "var(--tm-violet)" },
    teal: { bg: "var(--tm-teal-dim)", color: "var(--tm-teal)" },
    orange: { bg: "#fdf0e0", color: "#c9822a" },
  };
  const t = tones[tone] ?? tones.blue;
  return (
    <div className="tm-serviceIcon" style={{ background: t.bg, color: t.color }}>
      <Icon path={path} size={22} />
    </div>
  );
}

export default function MarketingHomepage({ onGetStarted }: { onGetStarted: (intent: AuthIntent) => void }) {
  return (
    <div className="tm-root">
      <TempMoversHero onGetStarted={onGetStarted} />

      {/* ---------- AI Job Assistant ---------- */}
      <section className="tm-section">
        <div className="tm-sectionInner tm-assistant">
          <div>
            <div className="tm-sectionEyebrow">Not sure what you need?</div>
            <h2 className="tm-sectionTitle">Describe the job. We&apos;ll figure out the rest.</h2>
            <p className="tm-sectionSub">Tell the TempMovers assistant what's moving, from where, and to where — it sorts out whether that's moving labor, a box truck, or freight, and gets you to the right quote.</p>
            <div style={{ display: "flex", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
              <button className="tm-btn tm-btnPrimary" onClick={() => onGetStarted({ mode: "register", role: "CUSTOMER" })}>Try the job assistant</button>
              <button className="tm-btn tm-btnGhost" onClick={() => onGetStarted({ mode: "register", role: "CUSTOMER" })}>Or book directly</button>
            </div>
          </div>
          <div className="tm-assistantCard">
            <div className="tm-assistantMsg tm-assistantMsgUser">I need to move a 3-bedroom house across town next Saturday, plus a piano.</div>
            <div className="tm-assistantMsg">
              That sounds like moving labor with 3–4 movers, plus a specialty item. For a piano, I&apos;d recommend adding a 4th mover for the extra care and lift time. Want me to build that quote?
            </div>
            <div className="tm-assistantInput">
              <Icon path={ICONS.send} size={15} /> Describe your move…
            </div>
          </div>
        </div>
      </section>

      {/* ---------- Service cards ---------- */}
      <section className="tm-section tm-sectionCream" id="services">
        <div className="tm-sectionInner">
          <div className="tm-sectionHead">
            <div className="tm-sectionEyebrow">What do you need help with?</div>
            <h2 className="tm-sectionTitle">One platform, every way you move something</h2>
          </div>
          <div className="tm-serviceGrid">
            {SERVICES.map((s) => (
              <a className="tm-serviceCard" href={s.href} key={s.title}>
                <ToneIcon path={s.icon} tone={s.tone} />
                <h3>{s.title}</h3>
                <p>{s.copy}</p>
                <span className="tm-serviceLink">Learn more <Icon path={ICONS.chevron} size={14} /></span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- How it works ---------- */}
      <section className="tm-section">
        <div className="tm-sectionInner">
          <div className="tm-sectionHead">
            <div className="tm-sectionEyebrow">How it works</div>
            <h2 className="tm-sectionTitle">Every job follows the same route</h2>
          </div>
          <div className="tm-route">
            <div className="tm-routePath" aria-hidden="true" />
            {WAYPOINTS.map((w, i) => (
              <div className="tm-waypoint" key={w.label}>
                <div className="tm-waypointDot">{i + 1}</div>
                <h3>{w.title}</h3>
                <p>{w.copy}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- Business solutions ---------- */}
      <section className="tm-section tm-sectionCream" id="business">
        <div className="tm-sectionInner tm-bizSplit">
          <div>
            <div className="tm-sectionEyebrow">For businesses</div>
            <h2 className="tm-sectionTitle">Recurring moves, one account</h2>
            <div className="tm-bizList">
              <div className="tm-bizItem"><Icon path={ICONS.check} size={18} /><div><strong>Recurring jobs</strong><span>Weekly store runs, restocks, and standing moving-labor bookings.</span></div></div>
              <div className="tm-bizItem"><Icon path={ICONS.check} size={18} /><div><strong>Consolidated invoicing</strong><span>One monthly invoice across every job, not one receipt per booking.</span></div></div>
              <div className="tm-bizItem"><Icon path={ICONS.check} size={18} /><div><strong>Dedicated support</strong><span>A single point of contact who already knows your account.</span></div></div>
            </div>
            <button className="tm-btn tm-btnPrimary" onClick={() => onGetStarted({ mode: "register", role: "CUSTOMER" })}>Set up a business account</button>
          </div>
          <div className="tm-bizPanel">
            <div className="tm-bizStatRow"><span>Jobs this month</span><strong className="tm-mono">142</strong></div>
            <div className="tm-bizStatRow"><span>Active locations</span><strong className="tm-mono">6</strong></div>
            <div className="tm-bizStatRow"><span>Avg. time to match</span><strong className="tm-mono">4 min</strong></div>
            <div className="tm-bizStatRow"><span>Next invoice</span><strong className="tm-mono">Aug 1</strong></div>
          </div>
        </div>
      </section>

      {/* ---------- Worker recruitment ---------- */}
      <section className="tm-section" id="recruit">
        <div className="tm-sectionInner">
          <div className="tm-recruit">
            <div>
              <div className="tm-sectionEyebrow" style={{ color: "#8fa6f0" }}>Become a mover, driver, or carrier</div>
              <h2 className="tm-recruitTitle">Set your schedule. Get paid per job, not per promise.</h2>
              <p className="tm-recruitSub">Movers and box-truck owner-operators get a guaranteed flat rate before they accept. Screening is a one-time fee — no recurring cut of your pay.</p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button className="tm-btn tm-btnPrimary" onClick={() => onGetStarted({ mode: "register", role: "MOVER" })}>Become a Mover</button>
                <button className="tm-btn tm-btnViolet" onClick={() => onGetStarted({ mode: "register", role: "DRIVER" })}>Drive With TempMovers</button>
              </div>
            </div>
            <div className="tm-recruitStats">
              <div className="tm-recruitStat"><strong>5,000+</strong><span>Active workers</span></div>
              <div className="tm-recruitStat"><strong>$32/hr</strong><span>Typical mover rate</span></div>
              <div className="tm-recruitStat"><strong>24–48h</strong><span>Screening turnaround</span></div>
              <div className="tm-recruitStat"><strong>Weekly</strong><span>Payouts</span></div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- Trust & safety ---------- */}
      <section className="tm-section tm-sectionCream">
        <div className="tm-sectionInner">
          <div className="tm-trustGrid">
            {TRUST_ITEMS.map((t) => (
              <div className="tm-trustItem" key={t.title}>
                <div className="tm-trustIcon"><Icon path={t.icon} size={22} /></div>
                <strong>{t.title}</strong>
                <span>{t.copy}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- Testimonials ---------- */}
      <section className="tm-section">
        <div className="tm-sectionInner">
          <div className="tm-sectionHead">
            <div className="tm-sectionEyebrow">Testimonials</div>
            <h2 className="tm-sectionTitle">What people book us for</h2>
          </div>
          <div className="tm-testGrid">
            {TESTIMONIALS.map((t) => (
              <div className="tm-testCard" key={t.name}>
                <div className="tm-testStars">★★★★★</div>
                <p className="tm-testQuote">&ldquo;{t.quote}&rdquo;</p>
                <div className="tm-testAuthor">
                  <div className="tm-testAvatar">{t.name.slice(0, 1)}</div>
                  <div><strong>{t.name}</strong><span>{t.context}</span></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- Service areas ---------- */}
      <section className="tm-section tm-sectionCream" id="pricing">
        <div className="tm-sectionInner">
          <div className="tm-sectionHead">
            <div className="tm-sectionEyebrow">Service areas</div>
            <h2 className="tm-sectionTitle">Currently serving Indianapolis &amp; surrounding areas</h2>
          </div>
          <div className="tm-areaGrid">
            {SERVICE_AREAS.map((a) => (
              <div className="tm-areaChip" key={a}>{a} <span>Active</span></div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- Footer ---------- */}
      <footer className="tm-footer" id="help">
        <div className="tm-footerGrid">
          <div className="tm-footerCol">
            <div className="tm-brand" style={{ color: "white", marginBottom: 14 }}>
              <span className="tm-brandMark"><Icon path={ICONS.truck} size={16} /></span> TempMovers
            </div>
            <p>Movers, box trucks, and freight carriers — one platform for Indianapolis and the surrounding area.</p>
          </div>
          <div className="tm-footerCol"><h4>Services</h4><a href="#">Moving Labor</a><a href="#">Box Truck Delivery</a><a href="#">Freight Shipping</a><a href="/book/junk">Junk Removal</a></div>
          <div className="tm-footerCol"><h4>For Businesses</h4><a href="#">Business Solutions</a><a href="#">Recurring Jobs</a><a href="#">Invoicing</a></div>
          <div className="tm-footerCol"><h4>Become a Worker</h4><a href="#">Become a Mover</a><a href="#">Drive With TempMovers</a><a href="#">Screening &amp; Pay</a></div>
          <div className="tm-footerCol"><h4>Help Center</h4><a href="#">Pricing</a><a href="#">Contact Support</a><a href="#">Trust &amp; Safety</a></div>
        </div>
        <div className="tm-footerBottom">
          <span>© {new Date().getFullYear()} TempMovers. All rights reserved.</span>
          <span>Secure payments · Visa · Mastercard · Apple Pay · Google Pay</span>
        </div>
      </footer>
    </div>
  );
}
