export class CertificialNotConfiguredError extends Error {
  constructor() {
    super("CERTIFICIAL_API_KEY is not configured.");
  }
}

/**
 * Real request shape against Certificial's documented insurance-monitoring
 * API — not tested against the live endpoint in this environment (no
 * network access here). Certificial's exact endpoint/payload shape should
 * be confirmed against their current API docs before first real use; this
 * follows their commonly documented pattern (submit a monitoring request
 * for a named insured, receive webhook updates as policy data changes).
 */
export async function submitInsuranceMonitoringRequest({
  workerId, insuredName, requiredCoverageTypes,
}: { workerId: string; insuredName: string; requiredCoverageTypes: string[] }) {
  const apiKey = process.env.CERTIFICIAL_API_KEY;
  if (!apiKey) throw new CertificialNotConfiguredError();

  const response = await fetch("https://api.certificial.com/v2/monitoring-requests", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ insured_name: insuredName, coverage_types: requiredCoverageTypes, external_reference: workerId }),
  });

  if (!response.ok) {
    throw new Error(`Could not submit Certificial monitoring request (${response.status}).`);
  }

  return response.json();
}
