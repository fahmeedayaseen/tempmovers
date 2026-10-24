"use client";

/**
 * Loads Stripe.js directly from Stripe's CDN rather than via the
 * @stripe/stripe-js npm package. This is a deliberate environment
 * constraint, not a style choice: this sandbox has no npm install
 * access, so a package that has never been installed here cannot be
 * verified to resolve, let alone work. Script-tag loading is Stripe's
 * own documented alternative (https://stripe.com/docs/js) and needs no
 * package installation at all — it is the one path that lets this
 * integration actually be written and reasoned about in this
 * environment, rather than left unbuilt indefinitely.
 *
 * IMPORTANT LIMITATION, stated plainly: this file has never been
 * executed against a real browser, a real network, or a real Stripe
 * account. The shape of window.Stripe(), elements.create(), and
 * stripe.confirmPayment() below is written from Stripe's public
 * documentation and this author's training knowledge, not verified
 * against the actual current Stripe.js API surface at runtime. Before
 * this touches production: load the app in a real browser with real
 * NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY test-mode credentials and confirm
 * the script actually loads, the PaymentElement actually mounts, and a
 * real test-mode card actually confirms successfully end to end.
 */

// Minimal hand-written types for only the subset of the Stripe.js
// surface this file actually uses — not the official @stripe/stripe-js
// types (that package was never installed here to check against).
export type StripeElements = {
  create: (type: "payment", options?: Record<string, unknown>) => StripeElement;
  getElement: (type: "payment") => StripeElement | null;
};
export type StripeElement = {
  mount: (domElement: HTMLElement) => void;
  unmount: () => void;
  on: (event: string, handler: (e: unknown) => void) => void;
};
export type StripeConfirmResult = {
  error?: { message?: string; type?: string };
  paymentIntent?: { id: string; status: string };
};
export type StripeInstance = {
  elements: (options: { clientSecret: string; appearance?: Record<string, unknown> }) => StripeElements;
  confirmPayment: (options: {
    elements: StripeElements;
    confirmParams?: Record<string, unknown>;
    redirect?: "if_required" | "always";
  }) => Promise<StripeConfirmResult>;
};

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeInstance;
  }
}

const STRIPE_JS_SRC = "https://js.stripe.com/v3/";
let loadPromise: Promise<StripeInstance> | null = null;

/**
 * Idempotent — safe to call from multiple components without loading
 * the script twice. Rejects clearly if NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
 * isn't configured, rather than failing silently deep inside Stripe.js.
 */
export function loadStripeClient(): Promise<StripeInstance> {
  if (loadPromise) return loadPromise;

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return Promise.reject(new Error("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not configured."));
  }

  loadPromise = new Promise((resolve, reject) => {
    if (window.Stripe) {
      resolve(window.Stripe(publishableKey));
      return;
    }
    const existing = document.querySelector(`script[src="${STRIPE_JS_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.Stripe) resolve(window.Stripe(publishableKey));
        else reject(new Error("Stripe.js loaded but window.Stripe was not defined."));
      });
      existing.addEventListener("error", () => reject(new Error("Failed to load Stripe.js.")));
      return;
    }
    const script = document.createElement("script");
    script.src = STRIPE_JS_SRC;
    script.async = true;
    script.onload = () => {
      if (window.Stripe) resolve(window.Stripe(publishableKey));
      else reject(new Error("Stripe.js loaded but window.Stripe was not defined."));
    };
    script.onerror = () => reject(new Error("Failed to load Stripe.js — check network access to js.stripe.com."));
    document.head.appendChild(script);
  });

  return loadPromise;
}
