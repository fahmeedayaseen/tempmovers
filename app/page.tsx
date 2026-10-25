"use client";

// ---------------------------------------------------------------------------
// BLOCK-10 — VASRUE Digital Media, 24 October 2026.
//
// `next build` failed to prerender "/" with:
//   "Functions cannot be passed directly to Client Components unless you
//    explicitly expose it by marking it with 'use server'."
//
// Cause: this page was a Server Component (the App Router default) while
// AuthGate is a Client Component, and the page hands AuthGate a render-prop
// function as children. A function cannot cross the server/client boundary, so
// React could not serialize it during static generation.
//
// The render-prop pattern itself is correct and worth keeping — AuthGate
// resolves the session and then hands the caller the user and service. The fix
// is to put this page on the same side of the boundary as the component it
// calls, which is where it always logically belonged: it renders nothing on its
// own and performs no server-side data fetching.
//
// Independent of the Next 15 params work. It could only be reached once the
// build got past type checking, which is why it had not surfaced before.
// ---------------------------------------------------------------------------
import AuthGate from "@/components/AuthGate";
import DashboardApp from "@/components/DashboardApp";

export default function Page() {
  return (
    <AuthGate>
      {(user, service) => <DashboardApp initialRole={user.role} initialService={service} />}
    </AuthGate>
  );
}
