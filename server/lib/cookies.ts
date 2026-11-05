import type { CookieOptions } from "express";
import { ENV, isProd } from "../config/env";

/**
 * Cookie policy for auth-tracked cookies (httpOnly JWT session + OAuth
 * state cookie). Single source of truth so a split deployment (frontend on
 * a different SITE than the API) only changes one env var:
 *
 * - COOKIE_SAMESITE="lax" (default): same-site/proxied single-origin or
 *   shared parent-domain deployments.
 * - COOKIE_SAMESITE="none": API on api.example.com, UI on app.example.com.
 *   Browsers only honor SameSite=none with Secure, so `secure` is forced on.
 */
export function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: ENV.COOKIE_SAMESITE === "none" || isProd,
    sameSite: ENV.COOKIE_SAMESITE,
    path: "/",
  };
}

/** Matches the 7-day JWT session expiry. */
export const SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** OAuth state cookie lives for 10 minutes (single-use CSRF guard). */
export const OAUTH_STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
