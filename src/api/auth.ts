/**
 * Dashboard authentication.
 *
 * Login: POST /api/auth/login
 *   - Accepts { password } and compares against DASHBOARD_PASSWORD using bcrypt
 *     (timing-safe, even though the env var is plain text — prevents timing attacks).
 *   - Returns a 24-hour JWT on success.
 *   - Rate-limited to 5 attempts per minute per IP.
 *
 * verifyToken: preHandler for all protected /api/* routes.
 *   Reads "Authorization: Bearer <token>" header or ?token= query param.
 */

import bcrypt from "bcryptjs";
import jwt    from "jsonwebtoken";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config }       from "../config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("auth");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardPayload extends jwt.JwtPayload {
  role: "dashboard";
}

// ---------------------------------------------------------------------------
// Pre-compute a bcrypt hash of DASHBOARD_PASSWORD at module load.
// This is done once so login remains fast (bcrypt.compare is async + constant-time).
// ---------------------------------------------------------------------------

let _passwordHash: string;

async function getPasswordHash(): Promise<string> {
  if (!_passwordHash) {
    _passwordHash = await bcrypt.hash(config.DASHBOARD_PASSWORD, 10);
  }
  return _passwordHash;
}

// Kick off hashing at startup (fire-and-forget — first login will await it)
getPasswordHash().catch((err) => log.error({ err }, "Failed to pre-hash dashboard password"));

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export function signToken(): string {
  const payload: DashboardPayload = { role: "dashboard" };
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

export async function verifyToken(
  req:   FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Accept token from Authorization header or ?token= query param (for WebSocket)
  const authHeader = req.headers["authorization"] as string | undefined;
  const queryToken = (req.query as Record<string, string | undefined>)["token"];

  let rawToken: string | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    rawToken = authHeader.slice(7);
  } else if (queryToken) {
    rawToken = queryToken;
  }

  if (!rawToken) {
    return reply.status(401).send({ error: "Missing authentication token" });
  }

  try {
    const decoded = jwt.verify(rawToken, config.JWT_SECRET) as DashboardPayload;
    if (decoded.role !== "dashboard") throw new Error("Invalid role");
    // Attach to request for downstream use if needed
    (req as FastifyRequest & { user: DashboardPayload }).user = decoded;
  } catch {
    return reply.status(401).send({ error: "Invalid or expired token" });
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAuthRoutes(app: FastifyInstance): void {
  // POST /api/auth/login
  // Rate limit is applied in index.ts at the plugin level (5/min for this route)
  app.post<{
    Body: { password?: unknown };
  }>(
    "/api/auth/login",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const { password } = req.body ?? {};

      if (typeof password !== "string" || !password) {
        return reply.status(400).send({ error: "password is required" });
      }

      const hash = await getPasswordHash();
      const ok   = await bcrypt.compare(password, hash);

      if (!ok) {
        log.warn({ ip: req.ip }, "Failed login attempt");
        // Uniform 401 — don't distinguish "wrong password" vs "no such user"
        return reply.status(401).send({ error: "Invalid password" });
      }

      const token     = signToken();
      const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;

      log.info({ ip: req.ip }, "Dashboard login successful");
      return reply.send({ token, expiresAt });
    },
  );
}
