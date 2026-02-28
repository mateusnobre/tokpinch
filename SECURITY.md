# Security

## Reporting vulnerabilities

Please do **not** open a public GitHub issue for security vulnerabilities.
Send a private report to the maintainers via GitHub's "Report a vulnerability"
button on the Security tab, or email the address listed in the repository's
contact information.

Include:
- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept preferred)
- Affected versions
- Any suggested mitigations

We aim to acknowledge reports within 48 hours and to release a fix within 14
days of confirmed impact.

---

## How API keys are handled

TokPinch is a **pass-through proxy**. It never stores, logs, or persists the
API keys that callers send.

- Callers supply their own `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in each
  request via `Authorization: Bearer <key>` or `x-api-key: <key>`.
- TokPinch forwards these headers verbatim to the upstream provider and
  discards them immediately after.
- The pino logger is configured with `redact` paths that mask `authorization`,
  `x-api-key`, `apiKey`, `api_key`, and related fields — they are replaced
  with `[REDACTED]` in every log line.
- The SQLite database stores only request **metadata** (model, token counts,
  cost, timestamp, session ID). Request bodies and API keys are never written
  to disk.
- The `requests` table schema has no column for keys, secrets, or message
  content — by design, there is nowhere to store them.

### Optional server-side keys

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` may optionally be set in the
server's environment to inject a key for clients that do not supply one.
These values are **never logged** (redacted at the config layer) and are
shown in the dashboard's Settings page in a masked form (`sk-ant-...xxxx`).

---

## Recommended deployment setup

TokPinch listens on plain HTTP. **In production, always place it behind a
reverse proxy (nginx, Caddy, Traefik) that terminates TLS.**

```
Internet → [nginx/Caddy — TLS termination] → TokPinch (HTTP, localhost only)
```

### nginx example (minimal)

```nginx
server {
    listen 443 ssl http2;
    server_name proxy.example.com;

    ssl_certificate     /etc/letsencrypt/live/proxy.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/proxy.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:4100;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Set `NODE_ENV=production` in the TokPinch environment so the server sends
`Strict-Transport-Security` headers and applies stricter behaviour.

### CORS

In production, set `ALLOWED_ORIGINS` to a comma-separated list of trusted
origins if the dashboard is accessed from a different host:

```
ALLOWED_ORIGINS=https://dash.example.com
```

---

## What data is stored

Only request **metadata** is persisted in SQLite:

| Column | Description |
|--------|-------------|
| `model` | Model name (e.g. `claude-sonnet-4-5`) |
| `input_tokens` / `output_tokens` | Token counts from the API response |
| `cost_usd` | Calculated cost |
| `session_id` | Caller-provided session ID from `x-openclaw-session` header |
| `timestamp` | Unix ms |
| `blocked` | Whether the request was blocked by budget/loop rules |
| `duration_ms` | End-to-end latency |

**Request bodies, system prompts, and message content are never stored.**

---

## Encryption at rest

SQLite data is stored unencrypted by default. Operators who require
encryption at rest should:

1. Use an encrypted volume (e.g. LUKS on Linux, BitLocker on Windows, or a
   cloud provider's encrypted EBS/persistent disk).
2. Or replace the SQLite backend with an encrypted database such as
   [SQLCipher](https://www.zetetic.net/sqlcipher/).

The SQLite file is created with `chmod 0600` (owner-read/write only) on
systems that support Unix permissions.

---

## Authentication

The dashboard is protected by a password (`DASHBOARD_PASSWORD`, minimum 8
characters) hashed with bcrypt (cost factor 10) at startup.
Successful login returns a JWT signed with `JWT_SECRET` (512-bit random key
by default, auto-rotated on restart if not pinned).

- JWT TTL: **24 hours**
- Login is rate-limited to **5 attempts per minute per IP**
- All `/api/*` routes (except `/api/auth/login`) require a valid JWT
- WebSocket connections are validated on connect and on every incoming message

---

## Security response headers

All responses include:

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `X-XSS-Protection` | `1; mode=block` |
| `Referrer-Policy` | `no-referrer` |
| `Content-Security-Policy` | `default-src 'self'; frame-ancestors 'none'; …` |
| `Strict-Transport-Security` | Set in `NODE_ENV=production` only |

---

## Docker hardening

The Docker image and Compose configuration apply:

- **Non-root user** — the container runs as `node` (UID 1000)
- **Read-only root filesystem** — `read_only: true`; only `/app/data` (the
  named volume) and `/tmp` (tmpfs) are writable
- **No new privileges** — `security_opt: [no-new-privileges:true]`
- **Minimal Alpine base** — `node:20-alpine` production image

---

## Test endpoint

`POST /test/mock-request` is disabled (`404`) when `NODE_ENV=production`.
It is only available in development/test environments to seed the database
with synthetic data.
