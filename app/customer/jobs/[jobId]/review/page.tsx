"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { authFetch, NotSignedInError } from "@/lib/client-auth";

type ReviewableWorker = {
  id: string;
  displayName: string;
  profilePhotoUrl?: string | null;
  alreadyReviewed: boolean;
};

type ReviewDraft = { rating: number; comment: string; tags: string[] };

const REVIEW_TAGS = ["PUNCTUAL", "PROFESSIONAL", "CAREFUL", "FRIENDLY", "EFFICIENT", "GOOD_COMMUNICATION"] as const;

export default function JobReviewPage() {
  const params = useParams<{ jobId: string }>();
  const router = useRouter();
  const [workers, setWorkers] = useState<ReviewableWorker[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [ineligible, setIneligible] = useState(false);

  useEffect(() => {
    void loadReviewableWorkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.jobId]);

  async function loadReviewableWorkers() {
    setLoading(true);
    try {
      const response = await authFetch(`/api/jobs/${params.jobId}/reviews`);
      const data = await response.json();
      if (!response.ok) {
        setIneligible(response.status === 403);
        throw new Error(data.error ?? "Could not load review form.");
      }
      setWorkers(data.workers);
      const initial: Record<string, ReviewDraft> = {};
      for (const worker of data.workers as ReviewableWorker[]) {
        initial[worker.id] = { rating: 0, comment: "", tags: [] };
      }
      setDrafts(initial);
    } catch (error) {
      setMessage(error instanceof NotSignedInError ? "Sign in to leave a review." : error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function setRating(workerId: string, rating: number) {
    setDrafts((current) => ({ ...current, [workerId]: { ...current[workerId], rating } }));
  }

  function toggleTag(workerId: string, tag: string) {
    setDrafts((current) => {
      const draft = current[workerId];
      const tags = draft.tags.includes(tag) ? draft.tags.filter((t) => t !== tag) : [...draft.tags, tag];
      return { ...current, [workerId]: { ...draft, tags } };
    });
  }

  async function submitReview(workerId: string) {
    const draft = drafts[workerId];
    if (!draft || draft.rating < 1 || draft.rating > 5) {
      setMessage("Select a rating from 1 to 5 stars.");
      return;
    }
    const response = await authFetch(`/api/jobs/${params.jobId}/reviews`, {
      method: "POST",
      body: JSON.stringify({ workerId, ...draft }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error ?? "Could not submit review.");
      return;
    }
    setWorkers((current) => current.map((w) => (w.id === workerId ? { ...w, alreadyReviewed: true } : w)));
    setMessage("Review submitted. Thank you.");
  }

  if (loading) return <main style={{ padding: 40, textAlign: "center", color: "#637089" }}>Loading review form…</main>;

  if (ineligible) {
    return (
      <main style={{ maxWidth: 480, margin: "0 auto", padding: "40px 24px", textAlign: "center" }}>
        <p style={{ color: "#637089" }}>{message ?? "This job isn't eligible for review yet — it must be completed and paid first."}</p>
        <button onClick={() => router.back()} style={{ marginTop: 16, padding: "10px 16px", borderRadius: 8, border: "1px solid #dce4ef", background: "white" }}>Back to job</button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "40px 24px" }}>
      <button onClick={() => router.back()} style={{ background: "none", border: "none", color: "#637089", fontSize: 13, fontWeight: 700, marginBottom: 16, cursor: "pointer", padding: 0 }}>← Back to job</button>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>How was your move?</h1>
      <p style={{ color: "#637089", marginBottom: 24 }}>Rate each mover who worked on this job.</p>

      {message && <div role="status" style={{ background: "#eaf0ff", border: "1px solid #c3d4fb", borderRadius: 10, padding: 12, marginBottom: 20, fontSize: 13, color: "#1f3f8f" }}>{message}</div>}

      {workers.length === 0 && <p style={{ color: "#637089" }}>No approved movers found for this job.</p>}

      {workers.map((worker) => {
        const draft = drafts[worker.id];
        return (
          <section key={worker.id} style={{ border: "1px solid #dce4ef", borderRadius: 12, padding: 20, marginBottom: 16 }}>
            <h2 style={{ fontSize: 16, marginBottom: 12 }}>{worker.displayName}</h2>
            {worker.alreadyReviewed ? (
              <p style={{ color: "#0f7e6b", fontSize: 13, fontWeight: 700 }}>Review already submitted.</p>
            ) : (
              <>
                <div aria-label={`Rating for ${worker.displayName}`} style={{ marginBottom: 14 }}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star} type="button"
                      aria-label={`${star} star${star === 1 ? "" : "s"}`}
                      aria-pressed={draft?.rating === star}
                      onClick={() => setRating(worker.id, star)}
                      style={{ background: "none", border: "none", fontSize: 26, cursor: "pointer", color: star <= (draft?.rating ?? 0) ? "#f5a623" : "#dce4ef", padding: 2 }}
                    >
                      {star <= (draft?.rating ?? 0) ? "★" : "☆"}
                    </button>
                  ))}
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                  {REVIEW_TAGS.map((tag) => {
                    const active = draft?.tags.includes(tag);
                    return (
                      <button
                        key={tag} type="button" aria-pressed={active}
                        onClick={() => toggleTag(worker.id, tag)}
                        style={{
                          border: "1px solid #dce4ef", borderRadius: 20, padding: "6px 12px", fontSize: 12, fontWeight: 700,
                          background: active ? "#172a48" : "white", color: active ? "white" : "#637089", cursor: "pointer",
                        }}
                      >
                        {tag.replaceAll("_", " ")}
                      </button>
                    );
                  })}
                </div>

                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#637089", marginBottom: 14 }}>
                  Comments (optional)
                  <textarea
                    maxLength={1000}
                    value={draft?.comment ?? ""}
                    onChange={(event) => setDrafts((current) => ({ ...current, [worker.id]: { ...current[worker.id], comment: event.target.value } }))}
                    style={{ width: "100%", marginTop: 6, padding: 10, border: "1px solid #dce4ef", borderRadius: 8, minHeight: 70, fontFamily: "inherit" }}
                  />
                </label>

                <button
                  type="button" onClick={() => submitReview(worker.id)}
                  style={{ width: "100%", padding: 12, borderRadius: 8, border: "none", fontWeight: 800, background: "#246bfd", color: "white", cursor: "pointer" }}
                >
                  Submit review
                </button>
              </>
            )}
          </section>
        );
      })}
    </main>
  );
}
