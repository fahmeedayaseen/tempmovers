"use client";

import { useEffect, useState } from "react";
import { getAuthToken, setAuthToken, getStoredUser, setStoredUser, clearAuthToken, logout, type StoredUser } from "@/lib/client-auth";
import MarketingHomepage from "@/components/marketing/MarketingHomepage";

type Mode = "login" | "register";
type AuthIntent = { mode: Mode; role?: "CUSTOMER" | "MOVER" | "DRIVER"; service?: "moving-labor" | "box-truck-delivery" | "freight" };

function AuthForms({
  onAuthed, onBack, initialMode = "login", initialRole = "CUSTOMER",
}: {
  onAuthed: (user: StoredUser, nextStep?: string) => void;
  onBack: () => void;
  initialMode?: Mode;
  initialRole?: "CUSTOMER" | "MOVER" | "DRIVER";
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState<"CUSTOMER" | "MOVER" | "DRIVER">(initialRole);
  const [workerType, setWorkerType] = useState<"MOVER" | "BOX_TRUCK_DRIVER" | "SEMI_DRIVER">("BOX_TRUCK_DRIVER");
  const [homeZip, setHomeZip] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body =
        mode === "login"
          ? { email, password }
          : {
              email, password, firstName, lastName, role,
              ...(role !== "CUSTOMER" ? { workerType, homeZip } : {}),
              acceptedTerms, marketingConsent,
            };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const message = typeof data.error === "string" ? data.error : "Something went wrong. Check your details and try again.";
        throw new Error(message);
      }
      setAuthToken(data.token);
      setStoredUser(data.user);
      onAuthed(data.user, data.nextStep);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = mode === "login"
    ? Boolean(email && password)
    : Boolean(email && password && firstName && lastName && acceptedTerms && (role === "CUSTOMER" || homeZip));

  return (
    <div className="authWrap">
      <div className="authCard">
        <button onClick={onBack} style={{ background: "none", border: "none", color: "#637089", fontSize: 13, fontWeight: 700, marginBottom: 14, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6 }}>← Back to homepage</button>
        <div className="brandMarkLg">TM</div>
        <h1>TempMovers</h1>
        <p className="authSub">Sign in to manage jobs, loads, and your subscription.</p>

        <div className="tabs" style={{ marginTop: 22 }}>
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create account</button>
        </div>

        {mode === "register" && (
          <>
            <div className="split" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div className="field"><label>First name</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></div>
              <div className="field"><label>Last name</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
            </div>
            <div className="field">
              <label>I am a</label>
              <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                <option value="CUSTOMER">Customer</option>
                <option value="MOVER">Mover</option>
                <option value="DRIVER">Driver</option>
              </select>
            </div>
            {role === "DRIVER" && (
              <div className="field">
                <label>Vehicle type</label>
                <select value={workerType} onChange={(e) => setWorkerType(e.target.value as typeof workerType)}>
                  <option value="BOX_TRUCK_DRIVER">Box truck</option>
                  <option value="SEMI_DRIVER">Semi tractor-trailer</option>
                </select>
              </div>
            )}
            {role !== "CUSTOMER" && (
              <div className="field">
                <label>Home ZIP</label>
                <input inputMode="numeric" maxLength={10} value={homeZip} onChange={(e) => setHomeZip(e.target.value)} placeholder="46220" />
              </div>
            )}
          </>
        )}

        <div className="field"><label>Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></div>
        <div className="field"><label>Password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "register" ? "At least 10 characters" : ""} /></div>

        {mode === "register" && (
          <>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, marginBottom: 10, textAlign: "left" }}>
              <input type="checkbox" checked={acceptedTerms} onChange={(e) => setAcceptedTerms(e.target.checked)} style={{ marginTop: 3 }} />
              <span>I accept the Terms of Service and Privacy Policy.</span>
            </label>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, marginBottom: 14, textAlign: "left" }}>
              <input type="checkbox" checked={marketingConsent} onChange={(e) => setMarketingConsent(e.target.checked)} style={{ marginTop: 3 }} />
              <span>Send me occasional product and market-launch updates (optional).</span>
            </label>
          </>
        )}

        {error && <p className="footerNote" style={{ color: "#c93c4d", marginBottom: 12 }}>{error}</p>}

        <button className="btn btnPrimary" style={{ width: "100%" }} disabled={busy || !canSubmit} onClick={submit}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account and continue setup"}
        </button>

        <p className="footerNote" style={{ marginTop: 18 }}>
          Admin accounts can't be created here — that's a separate protected
          path, matching the platform's rule that public signup can never
          provision an admin.
        </p>
      </div>
    </div>
  );
}

/**
 * Wraps the dashboard: shows the real login/register forms until a valid
 * session exists, then renders the dashboard with a working sign-out. Every
 * authed fetch elsewhere in the app (subscriptions, admin stats, etc.)
 * depends on this actually having run first.
 */
export default function AuthGate({ children }: { children: (user: StoredUser, service?: AuthIntent["service"]) => React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "marketing" | "auth" | "authed">("checking");
  const [authIntent, setAuthIntent] = useState<AuthIntent>({ mode: "login" });
  const [user, setUser] = useState<StoredUser | null>(null);

  useEffect(() => {
    const token = getAuthToken();
    const stored = getStoredUser();
    if (!token || !stored) {
      setStatus("marketing");
      return;
    }
    // Validate the stored token is still good rather than trusting it forever.
    fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => {
        if (!res.ok) throw new Error("Session expired.");
        setUser(stored);
        setStatus("authed");
      })
      .catch(() => {
        clearAuthToken();
        setStatus("auth");
      });
  }, []);

  function handleSignOut() {
    logout().finally(() => {
      setUser(null);
      setStatus("marketing");
    });
  }

  if (status === "checking") {
    return <div style={{ padding: 60, textAlign: "center", color: "#637089" }}>Loading…</div>;
  }

  if (status === "marketing") {
    return (
      <MarketingHomepage
        onGetStarted={(intent) => {
          setAuthIntent(intent);
          setStatus("auth");
        }}
      />
    );
  }

  if (status === "auth" || !user) {
    return (
      <AuthForms
        initialMode={authIntent.mode}
        initialRole={authIntent.role}
        onBack={() => setStatus("marketing")}
        onAuthed={(u, nextStep) => {
          setUser(u);
          setStatus("authed");
          if (nextStep && nextStep.startsWith("/onboarding")) {
            window.location.assign(nextStep);
          }
        }}
      />
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        className="btn btnSecondary"
        style={{ position: "fixed", top: 16, right: 16, zIndex: 50 }}
        onClick={handleSignOut}
      >
        Sign out ({user.email})
      </button>
      {children(user, authIntent.service)}
    </div>
  );
}
