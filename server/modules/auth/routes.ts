import { Router, type Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { safeEqual } from "../../lib/crypto";
import jwt from "jsonwebtoken";
import { CLIENT_ORIGINS, ENV, isDev } from "../../config/env";
import { logger } from "../../config/logger";
import { User, type UserDocument } from "../../models/User";
import { recordAuditLog } from "../../middleware/auditLog";
import { setAuthCookie, clearAuthCookie } from "../../middleware/auth";
import { cookieOptions, OAUTH_STATE_COOKIE_MAX_AGE_MS } from "../../lib/cookies";
import {
  createSessionToken,
  exchangeOAuthCode,
  fetchGitHubProfile,
  githubOAuthUrl,
  sanitizeUser,
  syncUser,
} from "./service";

/**
 * GitHub OAuth App flow (mode: oauth).
 * The GitHub App flow (mode: app) is added by the App module in a later commit.
 */

const GH_STATE_COOKIE = "gh_oauth_state";

export const authRouter = Router();

authRouter.get("/auth/github", (req: Request, res: Response) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ message: "GITHUB_CLIENT_ID is not configured" });
  }
  const redirectUri =
    process.env.GITHUB_REDIRECT_URI || `${req.protocol}://${req.get("host")}/api/auth/github/callback`;

  // OAuth state: CSRF protection; 10 min single-use cookie
  const state = randomBytes(16).toString("hex");
  res.cookie(GH_STATE_COOKIE, state, {
    ...cookieOptions(),
    maxAge: OAUTH_STATE_COOKIE_MAX_AGE_MS,
  });

  res.redirect(githubOAuthUrl(redirectUri, state));
});

authRouter.get("/auth/github/callback", async (req: Request, res: Response) => {
  const { code, state } = req.query;

  // 1. Verify state cookie vs param (CSRF)
  const cookieState = (req.cookies?.[GH_STATE_COOKIE] as string) || "";
  const paramState = typeof state === "string" ? state : "";
  logger.info({
  hasCookieHeader: Boolean(req.headers.cookie),
  hasParsedCookie: Boolean(req.cookies),
  hasStateCookie: Boolean(cookieState),
  hasQueryState: Boolean(paramState),
  cookieStateLength: cookieState.length,
  queryStateLength: paramState.length,
  stateMatches: Boolean(
    paramState &&
    cookieState &&
    safeEqual(paramState, cookieState)
  ),
}, "github oauth state diagnostics");
  if (!paramState || !cookieState || !safeEqual(paramState, cookieState)) {
    return res.status(403).send("OAuth state validation failed. Please restart sign-in.");
  }
  res.clearCookie(GH_STATE_COOKIE, cookieOptions());

  try {
    const redirectUri =
    process.env.GITHUB_REDIRECT_URI || `${req.protocol}://${req.get("host")}/api/auth/github/callback`;
    const rawToken = await exchangeOAuthCode(
    String(code),
    redirectUri,
    );
    const profile = await fetchGitHubProfile(rawToken);
    const user = await syncUser(profile, rawToken);

    // JWT delivered ONLY via httpOnly cookie — never in a URL
    const jwtToken = createSessionToken(user);
    setAuthCookie(res, jwtToken);

    recordAuditLog(req, { action: "auth.login", targetType: "user", targetId: String(user._id), meta: { provider: "github" } });
    const localFrontend = "http://localhost:5000";
    const frontendUrl =
      ENV.APP_URL ||
      (isDev && CLIENT_ORIGINS.includes(localFrontend)
        ? localFrontend
        : CLIENT_ORIGINS[0]);
    return res.redirect(new URL("/app", frontendUrl).toString());
  } catch (err) {
    logger.error({ err: (err as Error).message }, "github auth flow failed");
    return res.status(500).json({ message: "Internal server error during auth" });
  }
});

authRouter.get("/auth/logout", (req: Request, res: Response) => {
  clearAuthCookie(res);
  res.json({ message: "Logged out successfully" });
});

/** Silent auth status check: cookie first, Bearer fallback; never 401s. */
authRouter.get("/auth/user", async (req: Request, res: Response) => {
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.split(" ")[1]
    : undefined;
  const tokenCandidate =
    bearer || ((req as unknown as { cookies?: Record<string, string> }).cookies?.["audit_token"] as string | undefined);

  if (!tokenCandidate) {
    return res.json({ authenticated: false });
  }

  try {
    const decoded = jwt.verify(tokenCandidate, ENV.JWT_SECRET as string) as { userId?: string };
    if (!decoded.userId) {
      return res.json({ authenticated: false });
    }
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.json({ authenticated: false });
    }
    return res.json({ authenticated: true, user: await sanitizeUser(user as unknown as Record<string, unknown>) });
  } catch {
    return res.json({ authenticated: false });
  }
});
