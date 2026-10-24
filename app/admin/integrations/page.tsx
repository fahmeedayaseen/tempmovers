import IntegrationHealthPanel from "@/components/IntegrationHealthPanel";

/**
 * Admin → Integrations. Hosts the read-only Integration Health panel. The
 * panel fetches admin-only endpoints via authFetch; a non-admin will get a
 * 403 from the API and see the error state rather than any data.
 */
export default function AdminIntegrationsPage() {
  return (
    <main className="mx-auto max-w-4xl">
      <IntegrationHealthPanel />
    </main>
  );
}
