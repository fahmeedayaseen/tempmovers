"use client";

/**
 * Minimal client-side session token handling. There is no login page wired
 * up yet (see README) — this just gives components a single place to read/
 * write the token once one exists, instead of each component reinventing
 * localStorage access. authFetch() attaches it automatically and normalizes
 * the "not signed in" case so callers can show a real message instead of a
 * raw 401.
 */

const TOKEN_KEY = "tempmovers_token";
const USER_KEY = "tempmovers_user";

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}

export type StoredUser = { id: string; email: string; role: "CUSTOMER" | "MOVER" | "DRIVER" | "ADMIN" };

export function getStoredUser(): StoredUser | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
}

export function setStoredUser(user: StoredUser) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in.");
  }
}

export async function authFetch(input: string, init: RequestInit = {}) {
  const token = getAuthToken();
  if (!token) throw new NotSignedInError();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(input, { ...init, headers });
}

export type CurrentUser = {
  userId: string;
  role: "CUSTOMER" | "MOVER" | "DRIVER" | "ADMIN";
  workerId: string | null;
  customerId: string | null;
};

export async function fetchCurrentUser(): Promise<CurrentUser> {
  const res = await authFetch("/api/me");
  if (!res.ok) throw new Error(`Failed to load current user (${res.status}).`);
  return res.json();
}

export async function logout() {
  const token = getAuthToken();
  if (token) {
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // Best effort — clear the local token regardless of whether the
      // server-side revoke call succeeded.
    }
  }
  clearAuthToken();
}
