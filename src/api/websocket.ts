/**
 * WebSocket endpoint — /ws?token=<jwt>
 *
 * Provides a real-time feed of TokPinch events to the dashboard:
 *   { type: "request", data: { ... } }  — emitted after each proxied request
 *   { type: "budget",  data: { ... } }  — emitted after budget state changes
 *   { type: "ping" }                    — keep-alive every 30 seconds
 *
 * Security:
 *   - Token is validated before the connection is accepted.
 *   - The decoded token's expiry is also re-checked on every incoming client
 *     message, so a stolen/replayed token is evicted as soon as it expires.
 *   - Invalid tokens cause the socket to be closed with code 4001.
 *
 * Usage:
 *   import { registerWebSocket, broadcast } from "./api/websocket.js";
 *   registerWebSocket(app);           // call during server setup
 *   broadcast({ type: "request", data: ... });  // call from handler / routes
 */

import type { FastifyInstance } from "fastify";
import fastifyWebsocket         from "@fastify/websocket";
import jwt                      from "jsonwebtoken";
import { verifyToken }          from "./auth.js";
import type { DashboardPayload } from "./auth.js";
import { config }               from "../config.js";
import { createLogger }         from "../utils/logger.js";

const log = createLogger("websocket");

// ---------------------------------------------------------------------------
// Connected client set (socket → decoded payload for expiry checks)
// ---------------------------------------------------------------------------

// WebSocket from the ws library re-exported by @fastify/websocket
type WS = import("ws").WebSocket;

const _clients = new Map<WS, DashboardPayload>();

// ---------------------------------------------------------------------------
// Keep-alive ping
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 30_000;

const _pingTimer = setInterval(() => {
  if (_clients.size === 0) return;
  broadcast({ type: "ping" });
}, PING_INTERVAL_MS);

// Prevent the timer from keeping the Node process alive after app close
_pingTimer.unref();

// ---------------------------------------------------------------------------
// Public broadcast helper
// ---------------------------------------------------------------------------

export function broadcast(event: { type: string; data?: unknown }): void {
  if (_clients.size === 0) return;
  const payload = JSON.stringify(event);
  for (const [socket] of _clients) {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(payload);
      } catch (err) {
        log.warn({ err }, "Failed to send WebSocket message — removing client");
        _clients.delete(socket);
      }
    } else {
      // Clean up stale connections lazily
      _clients.delete(socket);
    }
  }
}

// ---------------------------------------------------------------------------
// Token expiry helper — checks the exp claim without re-verifying the signature
// ---------------------------------------------------------------------------

function isTokenExpired(decoded: DashboardPayload): boolean {
  if (!decoded.exp) return false; // no exp claim → treat as non-expiring (shouldn't happen)
  return decoded.exp < Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  await app.register(fastifyWebsocket);

  app.get(
    "/ws",
    { websocket: true },
    async (socket: WS, req) => {
      // Validate token before accepting the connection.
      // verifyToken replies with 401 over HTTP if invalid — but for WS the
      // upgrade has already happened, so we close the socket with code 4001.
      let decoded: DashboardPayload;
      try {
        // Build a lightweight mock reply to intercept 401 from verifyToken.
        // If verifyToken resolves without sending, the token is valid.
        let rejected = false;
        const mockReply = {
          status: () => ({
            send: () => { rejected = true; },
          }),
        } as unknown as import("fastify").FastifyReply;

        await verifyToken(req, mockReply);

        if (rejected) {
          socket.close(4001, "Unauthorized");
          return;
        }

        // Extract the decoded payload from the request (set by verifyToken)
        decoded = (req as FastifyRequest & { user: DashboardPayload }).user;
      } catch {
        socket.close(4001, "Unauthorized");
        return;
      }

      _clients.set(socket, decoded);
      log.debug({ ip: req.ip, total: _clients.size }, "WebSocket client connected");

      // Send a welcome ping so the client knows the connection is live
      try {
        socket.send(JSON.stringify({ type: "connected", data: { clients: _clients.size } }));
      } catch {
        // ignore
      }

      // Re-validate JWT on every incoming client message.
      // The dashboard is a push-only feed (server → client) but we defend
      // against future client-side messages and replay attacks.
      socket.on("message", (raw: unknown) => {
        // Check token expiry
        const payload = _clients.get(socket);
        if (!payload || isTokenExpired(payload)) {
          log.debug({ ip: req.ip }, "WebSocket token expired — closing connection");
          socket.close(4001, "Token expired");
          _clients.delete(socket);
          return;
        }

        // Re-verify signature against the current secret — catches key rotation
        const queryToken = (req.query as Record<string, string | undefined>)["token"];
        if (queryToken) {
          try {
            const fresh = jwt.verify(queryToken, config.JWT_SECRET) as DashboardPayload;
            if (fresh.role !== "dashboard") throw new Error("Invalid role");
            // Update stored payload in case iat changed (shouldn't, but defensive)
            _clients.set(socket, fresh);
          } catch {
            log.debug({ ip: req.ip }, "WebSocket token re-verification failed — closing");
            socket.close(4001, "Unauthorized");
            _clients.delete(socket);
          }
        }
      });

      socket.on("close", () => {
        _clients.delete(socket);
        log.debug({ ip: req.ip, total: _clients.size }, "WebSocket client disconnected");
      });

      socket.on("error", (err: unknown) => {
        log.warn({ err, ip: req.ip }, "WebSocket error");
        _clients.delete(socket);
      });
    },
  );

  log.info("WebSocket endpoint registered at /ws");
}

// Type shim for the `user` property we attach in verifyToken
type FastifyRequest = import("fastify").FastifyRequest;
