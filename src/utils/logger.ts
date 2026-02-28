import pino from "pino";
import { config } from "../config.js";

/**
 * Root logger — used directly or via createLogger() for child loggers.
 * API keys and secrets are redacted via serializers.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  transport:
    config.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
  redact: {
    paths: [
      // Nested object fields anywhere in the log payload
      "*.authorization",
      "*.apiKey",
      "*.api_key",
      "*.apikey",
      "*.x-api-key",
      "*.jwt_secret",
      "*.password",
      "*.smtp_pass",
      "*.token",
      "*.ANTHROPIC_API_KEY",
      "*.OPENAI_API_KEY",
      // Fastify request serialiser paths
      "req.headers.authorization",
      "req.headers.x-api-key",
      "req.headers['x-api-key']",
      "req.headers[\"x-api-key\"]",
      "req.headers.api-key",
    ],
    censor: "[REDACTED]",
  },
  serializers: {
    // Never include raw error stacks in production
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

/**
 * Create a child logger scoped to a specific module.
 *
 * @example
 * const log = createLogger("proxy");
 * log.info({ requestId }, "Forwarding request");
 */
export function createLogger(module: string): pino.Logger {
  return logger.child({ module });
}
