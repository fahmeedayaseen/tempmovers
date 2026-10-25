import DispatcherLoadWorkspace from "@/components/dispatcher/DispatcherLoadWorkspace";

// BLOCK-06 — VASRUE Digital Media, 24 Oct 2026.
// Next.js 15 made dynamic-route `params` a Promise. The Next 14 form
// ({ params }: { params: { loadId: string } }) no longer satisfies the
// generated PageProps constraint in .next/types, so `next build` halted here.
// Note this is invisible to `tsc --noEmit` — the constraint only exists once
// Next has generated its route types, so only a real build surfaces it.
// Conversion is mechanical: async component, Promise-typed params, await it.
export default async function DispatcherLoadPage({ params }: { params: Promise<{ loadId: string }> }) {
  const { loadId } = await params;
  return <DispatcherLoadWorkspace loadId={loadId} />;
}
