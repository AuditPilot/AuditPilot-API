import { AppError } from "../../middleware/errorHandler";
import { decryptSecret } from "../../lib/crypto";
import type { ProviderConnectionDocument } from "../../models/ProviderConnection";
import { GitHubClient } from "../github/client";
import { GitHubProvider, type ScmTransport } from "./github/provider";
import type { CapabilityKey, ProviderName, SourceControlProvider } from "./types";

/**
 * Resolves a ready SourceControlProvider from a connection or explicit token.
 * Credential-sourcing policy lives HERE — handlers never construct clients from
 * request tokens after the M2 rewiring (provider-abstraction.md §2).
 *
 * DB lookups stay with callers; the factory is pure and transport-injectable.
 */

export function providerFromTransport(provider: ProviderName, transport: ScmTransport): SourceControlProvider {
  switch (provider) {
    case "github":
      return new GitHubProvider(transport);
    case "bitbucket":
      // M5: BitbucketProvider lands with its OAuth refresh logic.
      throw AppError.badRequest("Bitbucket support is not available yet (planned for a later milestone)");
  }
}

export function providerFromToken(provider: ProviderName, token: string): SourceControlProvider {
  if (!token) throw AppError.badRequest("no valid provider token available");
  switch (provider) {
    case "github":
      return new GitHubProvider(new GitHubClient(token));
    case "bitbucket":
      throw AppError.badRequest("Bitbucket support is not available yet (planned for a later milestone)");
  }
}

export interface ConnectionCredentials {
  token: string;
}

export function parseConnectionCredentials(providerName: string, credentialsEncrypted: string): ConnectionCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecret(credentialsEncrypted));
  } catch {
    throw AppError.badRequest("stored provider credentials could not be decrypted — reconnect the provider");
  }
  const token = (parsed as { token?: unknown })?.token;
  if (typeof token !== "string" || !token) {
    throw AppError.badRequest(`stored ${providerName} credentials are incomplete — reconnect the provider`);
  }
  return { token };
}

export function providerFromConnection(connection: ProviderConnectionDocument): SourceControlProvider {
  if (connection.status === "revoked") {
    throw AppError.badRequest("provider connection has been revoked — reconnect the provider");
  }
  const { token } = parseConnectionCredentials(connection.provider, connection.credentialsEncrypted);
  return providerFromToken(connection.provider, token);
}

/** Capability gate helper for business logic. */
export function hasCapability(provider: SourceControlProvider, key: CapabilityKey): boolean {
  return provider.capabilities.has(key);
}
