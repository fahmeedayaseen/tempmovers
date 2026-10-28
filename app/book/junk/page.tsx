"use client";

// Junk removal — VASRUE Digital Media, 28 October 2026. The live route behind
// the homepage's "Junk Removal" card and footer link (Carl's junk spec §9).
// A signed-out visitor goes straight to sign-in / create account, then lands
// back here rather than on the dashboard.
import AuthGate from "@/components/AuthGate";
import JunkBookingWizard from "@/components/junk/JunkBookingWizard";

export default function BookJunkRemovalPage() {
  return (
    <AuthGate signedOutView="auth" signedOutIntent={{ mode: "register", role: "CUSTOMER" }}>
      {(user) => <JunkBookingWizard user={user} />}
    </AuthGate>
  );
}
