import { AppError } from "../../middleware/errorHandler";
import { decryptSecret } from "../../lib/crypto";
import { logger } from "../../config/logger";
import { ProviderConnection } from "../../models/ProviderConnection";
import { User } from "../../models/User";
import { Workspace } from "../../models/Workspace";
import { providerFromConnection, providerFromToken } from "../../integrations/source-control/provider-factory";
import type { ProviderName, SourceControlProvider } from "../../integrations/source-control/types";

/**
 * Credential-sourcing policy (provider-abstraction.md §2/§5): resolve the
 * workspace's connected provider, or — for the legacy user-scoped routes during
 * the M2 transition — the user's personal-workspace connection. Handlers never
 * build clients from request tokens.
 */

export async function providerForWorkspace(
  workspaceId: string,
  provider: ProviderName = "github",
): Promise<SourceControlProvider> {
  const connection = await ProviderConnection.findOne({
    workspaceId,
    provider,
    status: { $ne: "revoked" },
  });
  if (!connection) {
    throw AppError.badRequest(
      `No connected ${provider} connection in this workspace. Connect the provider first.`,
    );
  }
  return providerFromConnection(connection);
}

export async function providerForUser(
  userId: string,
  provider: ProviderName = "github",
): Promise<SourceControlProvider> {
  const personal = await Workspace.findOne({ owner: userId, type: "personal" });
  if (personal) {
    const connection = await ProviderConnection.findOne({
      workspaceId: personal._id,
      provider,
      status: { $ne: "revoked" },
    });
    if (connection) return providerFromConnection(connection);
  }

  // Migration safety net: the M1 migration clones the OAuth session token into
  // the personal workspace's connection. Users who skipped it re-authenticate.
  const user = await User.findById(userId).select("accessTokenEncrypted");
  if (user?.accessTokenEncrypted) {
    logger.warn({ userId }, "[deprecated] resolved provider token from legacy User.accessTokenEncrypted — run migrate-workspaces");
    return providerFromToken(provider, decryptSecret(user.accessTokenEncrypted));
  }

  throw AppError.badRequest("GitHub connection not found. Re-authenticate or run the workspace migration.");
}
