import { encryptSecret, decryptSecret } from "../../lib/crypto";
import { ENV } from "../../config/env";
import jwt from "jsonwebtoken";
import { User, type UserDocument } from "../../models/User";
import { usageForSanitizedUser } from "../usage/service";

/**
 * Resolves the decrypted GitHub token for a user WITHOUT a request object
 * (job workers / scripts). Transparently falls back to the legacy plaintext
 * field until that user's first authenticated migration runs.
 * Returns null when the user has no token on record.
 */
export async function githubTokenForUser(userId: string | unknown): Promise<string | null> {
  const user = (await User.findById(String(userId), null, {
    select: "+accessToken +accessTokenEncrypted",
    lean: true,
  })) as {
    _id: unknown;
    accessToken?: string | null;
    accessTokenEncrypted?: string | null;
  } | null;
  if (!user) return null;
  if (user.accessTokenEncrypted) {
    try {
      return decryptSecret(user.accessTokenEncrypted);
    } catch {
      return null;
    }
  }
  return user.accessToken ?? null;
}

export interface GitHubProfile {
  id: string | number;
  login: string;
  name?: string | null;
  avatar_url: string;
  email?: string | null;
}

export interface OAuthTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export function githubOAuthUrl(redirectUri: string, state: string): string {
  return `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=repo%20read:user&state=${encodeURIComponent(state)}`;
}

export async function exchangeOAuthCode(code: string,redirectUri: string ): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Audit-Pilot-App",
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = (await res.json()) as OAuthTokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
      data.error ||
      `GitHub token exchange failed: ${res.status}`,
    );
  }
  return data.access_token;
}

export async function fetchGitHubProfile(token: string): Promise<GitHubProfile> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Audit-Pilot-App",
    },
  });
  const profile = (await res.json()) as GitHubProfile;
  if (!profile?.id) {
    throw new Error("Failed to verify GitHub profile");
  }
  return profile;
}

/** Upsert the user keyed by githubId; the token is stored ENCRYPTED. */
export async function syncUser(profile: GitHubProfile, rawToken: string): Promise<UserDocument> {
  const encryptedToken = encryptSecret(rawToken);
  const user = await User.findOneAndUpdate(
    { githubId: profile.id.toString() },
    {
      username: profile.login,
      displayName: profile.name || profile.login,
      avatarUrl: profile.avatar_url,
      email: profile.email,
      accessTokenEncrypted: encryptedToken,
      $unset: { accessToken: 1 },
      lastLogin: new Date(),
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  return user;
}

export function createSessionToken(user: UserDocument): string {
  return jwt.sign({ userId: user._id }, ENV.JWT_SECRET as string, { expiresIn: "7d" });
}

/**
 * Fields safe to send to clients. Token fields are NEVER included.
 * Usage counts come from the monthly usage LEDGER under the legacy field
 * names (auditsUsed / pullRequestsUsed) so the client contract is unchanged.
 */
export async function sanitizeUser(user: UserDocument | Record<string, unknown>) {
  const usage = await usageForSanitizedUser(String(user._id));
  return {
    _id: user._id,
    username: user.username,
    displayName: user.displayName ?? null,
    avatarUrl: user.avatarUrl ?? null,
    email: user.email ?? null,
    plan: user.plan,
    auditsUsed: usage.auditsUsed,
    pullRequestsUsed: usage.pullRequestsUsed,
  };
}
