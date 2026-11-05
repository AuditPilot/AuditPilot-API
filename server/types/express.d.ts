/**
 * Centralized Express request augmentations.
 *
 * IMPORTANT: these must live on "express-serve-static-core" — that is where
 * the `Request` interface is actually defined. Augmenting "express" instead
 * splits the Request type between @types/express and @types/express-serve-static-core,
 * which makes every router.get/post(...) call unassignable (TS2769).
 */
import type { Logger } from "../config/logger";
import type { UserDocument } from "../models/User";

declare module "express-serve-static-core" {
  interface Request {
    /** Set by middleware/requestContext.ts */
    requestId?: string;
    /** Set by middleware/requestContext.ts — request-scoped pino logger. */
    log: Logger;
    /** Set by middleware/requestContext.ts — performance timing start. */
    startAt?: number;
    /**
     * Set by middleware/auth.ts. The FULL user document (includes encrypted
     * token fields). Never serialize this object directly to clients — use
     * modules/auth/service.ts sanitizeUser().
     */
    user?: UserDocument;
    /** Set by middleware/auth.ts — encrypted at rest, never sent to clients. */
    githubTokenEnc?: string | null;
    /** Set by middleware/auth.ts — decrypted token for outbound GitHub calls. */
    githubAccessToken?: string | null;
  }
}
