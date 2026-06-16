# ADR 0001 — Native ClickHouse access via an app-enforced Query Gateway + Personal Access Tokens

- **Status:** Proposed
- **Date:** 2026-06-16
- **Deciders:** CHouse UI maintainers
- **Tags:** RBAC, data-access, ClickHouse, connectivity, security
- **Related:** `docs/sso.md`, `docs/datagrip-connection.md`

---

## Context

Today CHouse UI is the **only** path to ClickHouse. Data engineers increasingly
want to use native client tools — **JetBrains DataGrip**, the **ClickHouse CLI**,
BI tools — directly against the same data, without giving up the governance the
app provides.

### How access works today (the facts that constrain this decision)

All security lives in the **application proxy layer**, not in ClickHouse:

1. **The browser never talks to ClickHouse.** The SPA calls the server
   (JWT-authenticated, `jose` HS256), which executes queries over **HTTP**
   (`@clickhouse/client`, port 8123) using a **shared, server-side,
   AES-256-GCM-encrypted connection credential** (`rbac/services/connections.ts`).
   Connections are application-scoped, not per-user; a user "sees" a connection
   only if a data-access policy attached to their role allows it.

2. **Enforcement happens in-process, before the query is sent:**
   - **RBAC permission checks** — JWT carries `roles` + fine-grained
     `permissions` (`table:select`, `query:execute_ddl`, …); middleware gates the
     operation (`rbac/middleware/rbacAuth.ts`, `middleware/dataAccess.ts`).
   - **SQL parsing** — `node-sql-parser` extracts statement type + referenced
     tables (`middleware/sqlParser.ts`).
   - **Data-access policies** — wildcard/regex `database`/`table` patterns with
     allow/deny + priority, evaluated per statement, per table
     (`rbac/services/dataAccess.ts`).
   - **Audit + query history** — written to the app DB; the RBAC user id is also
     tagged into ClickHouse's `log_comment` for correlation.
   - **Live query view + kill** — backed by `system.processes` plus the app's
     own session tracking (`services/clickhouse.ts`).

3. **The app already manages real ClickHouse users** (`CREATE USER` DDL,
   `rbac/services/clickhouseUsers.ts`) — but those native users are a *separate*
   identity space from app RBAC users and are **not** what we want to lean on
   here (see Decision).

### The core tension

A native client speaks ClickHouse's **wire protocol** directly:

- **HTTP interface** — port 8123/8443 (DataGrip's JDBC driver, `curl`, most BI
  tools).
- **Native TCP protocol** — port 9000/9440 (the `clickhouse-client` CLI).

If a client connects straight to ClickHouse, it **bypasses every app-layer
control** above — RBAC, data-access policies, audit, live-query tracking. The
real question is therefore *not* "open a port" but **"where do authentication,
authorization and audit live when the app is no longer in the request path?"**

### What we want (the chosen product shape)

> Use the **app's** authentication, RBAC and data-access rules to govern queries
> from native tools. Keep the **live query view** and the ability to **manage
> data-access rules** as the single control surface. Map to a **single
> super-admin service account on ClickHouse** and keep **all authn/authz +
> audit in the app's power**. **Do not replicate users or roles into
> ClickHouse** — we already have them in the app.

We run on **Kubernetes**, so we may add **sidecars / extra components** rather
than forcing everything into the existing server process.

---

## Decision

Build a **ClickHouse Query Gateway**: an HTTP endpoint that is **wire-compatible
with ClickHouse's HTTP interface**, authenticates the caller with a **Personal
Access Token (PAT)**, runs the **existing app enforcement pipeline** (RBAC →
SQL parse → data-access policy → audit/live-query), and forwards approved
queries to the real ClickHouse using **one shared super-admin service account**.

In short — the gateway makes the app a **policy enforcement point (PEP)** that
*speaks ClickHouse* so existing native tools can point at it unchanged.

Concretely:

1. **Personal Access Tokens (PAT)** — a new credential type a user can mint in
   the UI and paste into a native tool as the ClickHouse "password". The PAT
   *is* the bearer of the user's app identity for non-browser clients. Every PAT
   is **bound to exactly one connection** and has a **bounded, non-infinite
   expiry**; the number of active PATs per user is **capped** (see PAT design).
2. **Query Gateway** — a new listener implementing the subset of the ClickHouse
   HTTP API that real clients use, authenticating via PAT and reusing the
   enforcement pipeline.
3. **Single service account** — the gateway connects downstream to ClickHouse
   with one privileged service credential (the existing connection model). We do
   **not** create or sync per-user ClickHouse users or roles.
4. **App is the source of truth** for identity, authorization and audit. ClickHouse
   only sees the service account; the gateway injects per-user attribution
   (`log_comment`, `query_id`, `quota_key`) for correlation.

### Why this option (vs. pushing RBAC down into ClickHouse)

The alternative — provision a native ClickHouse user/role per engineer and
compile app policies into ClickHouse `GRANT`/`ROW POLICY` — was rejected for this
goal because it:

- **splits the source of truth** (app RBAC vs. ClickHouse RBAC must be kept in
  sync), which is exactly what "don't replicate users/roles" rules out;
- **can't faithfully express** the app's regex/priority/deny policy model in
  ClickHouse's additive grant model;
- **splits audit and live-query** away from the app's single control surface.

The trade-off we accept: the gateway is **HTTP-only**, so the native-TCP
`clickhouse-client` CLI is **not** covered in v1 (see Consequences and Future
work). DataGrip and the broad HTTP/JDBC ecosystem are covered.

---

## Architecture

```
                          ┌──────────────────────────────────────────────┐
                          │                CHouse UI                       │
  ┌──────────┐  HTTP(S)   │  ┌───────────────┐     ┌──────────────────┐   │
  │ DataGrip │──────────► │  │ Query Gateway │────►│ Enforcement core │   │
  │  (JDBC)  │  PAT as    │  │ (CH HTTP API  │     │ • PAT auth       │   │
  └──────────┘  password  │  │  compatible)  │     │ • RBAC perms     │   │
                          │  └───────┬───────┘     │ • SQL parse      │   │
  ┌──────────┐            │          │             │ • data-access    │   │
  │ BI / curl│──────────► │          │             │ • audit + live Q │   │
  └──────────┘            │          │             └──────────────────┘   │
                          │          │ @clickhouse/client (HTTP 8123)      │
                          │          │ ONE shared super-admin service acct │
                          └──────────┼──────────────────────────────────── ┘
                                     ▼
                          ┌────────────────────┐
                          │     ClickHouse      │  (only the gateway can reach it;
                          │  system.query_log   │   NetworkPolicy + TLS)
                          └────────────────────┘
```

The gateway **reuses** the modules that already implement enforcement
(`middleware/sqlParser.ts`, `rbac/services/dataAccess.ts`, audit + live-query in
`services/clickhouse.ts`). The new surface is *transport + auth*, not a second
copy of the policy engine.

### Request flow

1. DataGrip opens an HTTP(S) connection to the gateway and sends credentials
   (HTTP Basic `user:password` or `X-ClickHouse-User` / `X-ClickHouse-Key`
   headers) with the SQL in the request body — exactly as it would to ClickHouse.
2. Gateway extracts the PAT from the password/key field, **authenticates** it,
   and resolves the **app user + roles + permissions** (+ effective data-access
   rules). The "user" field is informational; the **PAT is authoritative**.
3. Gateway **parses** the SQL (`node-sql-parser`) → statement types + tables.
4. Gateway runs **RBAC permission** + **data-access policy** checks per
   statement/table — the same code path the UI uses. Fail → ClickHouse-shaped
   error response (so the tool surfaces it cleanly).
5. Approved → gateway **forwards** to ClickHouse via the shared service account,
   **forcing safe settings** and **stripping dangerous ones** (see Security), and
   streams the result back in the **format the client asked for**
   (TabSeparated / JSONCompact / RowBinary…).
6. Gateway **audits** the query and **registers it in the live-query view** with
   a server-issued `query_id` and a per-user `quota_key`, so existing
   "kill query" / live monitoring keeps working.

### Connection selection (which cluster a session targets)

A user can have access to **multiple control-plane connections** (each = a
ClickHouse endpoint + its own service-account credential), but a DataGrip data
source is a single `(host, port, database, user, password)`. The gateway must
therefore decide **which connection** a session maps to. Note a *connection* is a
whole ClickHouse endpoint; the JDBC **database** field selects a DB *within* the
chosen connection and is orthogonal to this.

**Decision: a PAT is always bound to exactly one connection.** Connection
selection is therefore **carried by the credential itself** — there is no
ambiguity to resolve at query time and no client-side selector to configure:

- The connection is **fixed by the PAT's `connection_id`** and treated as a
  security boundary. Any client-supplied routing hint that names a *different*
  connection is **rejected**, never honoured.
- UX: **one PAT — and one DataGrip data source — per connection.** To work
  against two clusters, mint two tokens. Per-connection revocation comes for
  free (revoking a token only affects its connection).
- The bound connection must still be one the user's **data-access policies
  permit** at mint time *and* at query time; if access is later revoked, the PAT
  stops working. The PAT never widens access beyond the user's policies.
- Operators may optionally expose a per-connection **subdomain/host or path**
  purely as ergonomic convenience (a human-friendly endpoint per cluster); it is
  **not** a selector, since the PAT already determines the connection.

The JDBC **database** field still selects a DB *within* the bound connection and
is orthogonal to connection selection.

---

## Personal Access Tokens (PAT) — design

Native tools authenticate with a username + password (or header key); they
cannot present a short-lived JWT. The PAT bridges that gap.

### Token shape

```
chpat_<tokenId>_<secret>
        │          └── 32+ bytes of CSPRNG entropy (base62)
        └── public lookup id (indexed), NOT secret
```

- The user pastes the **whole string** as the ClickHouse password.
- We **store only**: `tokenId` (indexed, for O(1) lookup) and a **hash of the
  secret**. The plaintext is shown **once** at creation.

### Storage & verification

- New table `rbac_personal_access_tokens`:
  `id` (= tokenId), `user_id`, `name`, `secret_hash`,
  `connection_id` (**NOT NULL** — every PAT is bound to one connection),
  `scopes` (nullable, default = inherit the user's permissions for that
  connection), `expires_at` (**NOT NULL** — no infinite tokens),
  `last_used_at`, `created_at`, `revoked_at`, `created_ip`.
- **Hashing:** the secret is high-entropy, so a **SHA-256** + constant-time
  compare is sufficient and fast — we deliberately avoid Argon2id here because
  the gateway verifies a token on **every query** (hot path). (Passwords still
  use Argon2id; that rationale doesn't apply to high-entropy random secrets.)
- A short-lived **in-memory cache** (e.g. 30–60 s) of `tokenId → resolved
  identity` avoids a DB hit per query; invalidated on revoke.

### Lifecycle

- **Mint / list / revoke** in the UI (Preferences → Access Tokens) and via
  authenticated API. Minting **requires** picking a target connection and a TTL
  within the allowed bounds (below). Listing never returns the secret.
- **Connection binding (mandatory):** every PAT targets exactly one connection
  the user may access — see [Connection selection](#connection-selection-which-cluster-a-session-targets).
- **Expiry (mandatory, bounded):** no infinite tokens. The requested TTL must
  fall within `[5 minutes, AUTH_PAT_MAX_TTL]` (see Limits) and is rejected
  otherwise; if omitted it defaults to `min(default, AUTH_PAT_MAX_TTL)`.
  Expired tokens are rejected at auth time and swept by a periodic job.
- **Per-user cap:** a user may hold at most `AUTH_PAT_MAX_PER_USER` **active**
  (non-expired, non-revoked) tokens; minting beyond the cap is refused with a
  message to revoke an existing token first.
- **Rotation** = mint new + revoke old.
- **Permission scope (optional):** a PAT may be further narrowed to a subset of
  the user's permissions on that connection (least privilege for a BI tool that
  only needs SELECT). It can never exceed the user's own permissions.
- **Revocation** is immediate (cache TTL bounds the window) and on user
  disable/delete the user's PATs are cascaded revoked.
- **Audit** events: `pat.create`, `pat.revoke`, `pat.use_failed`, and every
  gateway query carries the originating `tokenId`.

### Limits & configuration

Expiry bounds and the per-user cap are **operator-controlled**. The 5-minute
floor is a fixed hard minimum (a token shorter than that is never useful and only
adds churn); the maximum and the cap are admin-configurable.

| YAML | Env | Default | Meaning |
|------|-----|---------|---------|
| — | — | `5m` (fixed floor) | Minimum TTL a PAT may be minted with; requests below are rejected. Not configurable. |
| `auth.pat.max_ttl` | `AUTH_PAT_MAX_TTL` | `90d` | Maximum TTL an admin allows. A mint request above this is rejected; the UI clamps the picker to it. |
| `auth.pat.default_ttl` | `AUTH_PAT_DEFAULT_TTL` | `30d` | TTL used when the user doesn't specify one (always clamped into `[5m, max_ttl]`). |
| `auth.pat.max_per_user` | `AUTH_PAT_MAX_PER_USER` | `10` | Max **active** tokens per user; minting beyond this is refused. |

Durations accept `m`/`h`/`d` suffixes (e.g. `5m`, `12h`, `90d`). Validation is
enforced **server-side** (the authoritative boundary); the UI mirrors the same
bounds for a good experience but is never the only gate.

### Why not reuse the existing API keys / JWT refresh tokens?

JWTs are short-lived and not pasteable into a tool's static password field; the
break-glass/SSO login flow is interactive. PATs are purpose-built: long-lived,
revocable, scoped, and designed to ride in a password field.

---

## Security considerations (critical — the gateway holds super-admin)

Because the downstream credential is a **super-admin service account**, the
gateway is the *entire* security boundary. Its enforcement must be **fail-closed**
and resistant to ClickHouse-specific escape hatches. The SQL parser is no longer
"defense in depth" — here it is **load-bearing**.

Mandatory controls:

1. **Force-safe settings, strip client settings.** The gateway must *inject* and
   *pin* protective settings and **ignore** client-supplied overrides:
   - pin `readonly` appropriately for the user's permission set;
   - cap `max_execution_time`, `max_result_rows`, `max_result_bytes`,
     `max_memory_usage`, `max_rows_to_read` (resource quotas);
   - never let the client set `log_comment`, `database`, or settings that relax
     limits. Maintain an **allowlist** of forwardable settings.
2. **Block privilege-escalation & data-exfil vectors** at parse time
   (deny-by-default), e.g.:
   - DCL/identity: `CREATE/ALTER/DROP USER|ROLE|QUOTA|ROW POLICY`, `GRANT`,
     `REVOKE`.
   - `SYSTEM …` commands.
   - Table functions that read arbitrary sources and **bypass data-access**:
     `url()`, `file()`, `s3()`, `remote()`, `jdbc()`, `mysql()`, `postgresql()`,
     `hdfs()`, dictionaries, `INTO OUTFILE`, `FROM INFILE`.
   - Reading sensitive `system.*` tables (e.g. those exposing the service
     account, settings, or other users' queries) unless explicitly permitted.
3. **Multi-statement safety.** Validate **every** statement; reject what the
   parser cannot fully understand (no "parse failed → allow"). Constrain or
   reject `multiquery`.
4. **No raw passthrough.** The gateway must not have a "forward verbatim" mode
   that skips parsing. Anything the parser can't classify is denied.
5. **Transport.** TLS on the gateway; mTLS or NetworkPolicy so **only** the
   gateway can reach ClickHouse's real ports. Never expose ClickHouse directly.
6. **Abuse limits.** Per-PAT rate limiting and concurrency caps; lock/alert on
   repeated `pat.use_failed`.
7. **Attribution that can't be spoofed.** `query_id`, `quota_key`, and
   `log_comment` are set **server-side** from the resolved identity, never from
   client input.

> **Residual risk to call out explicitly:** parser coverage is the boundary. New
> ClickHouse syntax / table functions can open holes. Mitigate with an
> allowlist-first posture (permit known-safe shapes rather than blocklist all bad
> ones) and a tightly-scoped downstream account where feasible — even a
> "super-admin minus dangerous grants" service role narrows the blast radius.

---

## Kubernetes deployment options

The gateway can be packaged three ways; the ADR proposes **(A) for v1**, with
(C) as the path for private/remote clusters.

**A. In-process listener (recommended v1).** A second route/port in the existing
Bun + Hono server. Simplest; shares the enforcement code and DB directly. Expose
via a dedicated `Service` + `Ingress`/`Gateway` with TLS.

**B. Dedicated gateway Deployment.** Same image, run with a `gateway`-only role,
scaled and network-isolated independently of the UI/API. Better blast-radius
isolation and independent scaling; needs shared access to the RBAC DB +
encryption keys.

**C. Connectivity sidecar / outbound agent (for private clusters).** When
ClickHouse is in a network the gateway can't reach inbound, run a small
**outbound-only agent** next to ClickHouse that dials back to the gateway —
the pattern [ch-ui's "Remote ClickHouse Tunnel"](#evaluation-ch-ui-remote-clickhouse-tunnel)
uses (a `wss://` relay + token, agent talks `http://127.0.0.1:8123` locally).
This keeps ClickHouse ports off the internet and avoids firewall changes.

**Optional sidecar: `chproxy`.** A ClickHouse HTTP proxy sidecar between the
gateway and ClickHouse can add connection pooling, per-user quota_key routing,
and request limits. It does **not** replace app enforcement (it can't read app
policies) — it's an operational reliability layer only.

### Evaluation: ch-ui "Remote ClickHouse Tunnel"

We reviewed `caioricciuti/ch-ui`'s tunnel feature. Findings:

- It is a **secure WebSocket relay** (`wss://`), **not** a TCP/SSH tunnel.
- Topology: a **server** (the UI) + a lightweight **agent** (`ch-ui connect`)
  deployed next to ClickHouse; the **agent dials out** to the server's
  `/connect` endpoint (outbound-only), so ClickHouse needs no inbound exposure.
- Auth is **token-based** (`cht_…`), tokens minted/rotated server-side
  (`ch-ui tunnel create|rotate`). Agent installs as an OS service or Docker
  sidecar (`ch-ui service install --key … --url wss://host/connect`).
- It talks to the **local ClickHouse over HTTP 8123** (`--clickhouse-url`).

**What we can borrow:** the **outbound-agent + token** pattern solves the
"gateway must reach a ClickHouse it can't route to inbound" sub-problem (our
option C), and validates the **HTTP-8123 + opaque-token** approach the PAT design
already takes. **What it does not solve for us:** it connects *the UI server* to a
remote ClickHouse; it does **not** let *external native clients* authenticate as
app users with app-enforced authz. So it is a **complementary connectivity
transport**, not the enforcement design — the gateway + PAT remains the core.

---

## Consequences

### Positive
- One control surface: existing **RBAC, data-access rules, audit, and live-query
  view** govern native-tool traffic with no second policy engine.
- **No user/role replication**, no app↔ClickHouse RBAC drift.
- Works with the broad **HTTP/JDBC** tool ecosystem (DataGrip, BI, `curl`).
- Per-query **attribution** and **kill** continue to work.

### Negative / accepted
- **HTTP-only in v1** → the native-TCP `clickhouse-client` CLI is not supported
  yet (see Future work). HTTP-based usage (incl. DataGrip) is fully covered.
- The gateway is a **single, high-value boundary** in front of a super-admin
  account — its parser/allowlist correctness is security-critical and needs
  ongoing maintenance as ClickHouse evolves.
- **Performance:** all native traffic now flows through the app; needs streaming
  and pooling to avoid becoming a bottleneck (mitigated by per-query streaming
  and optional `chproxy` sidecar).
- New **secret material** (PATs) to manage, rotate and audit.

---

## Alternatives considered

1. **Per-user ClickHouse users + compile app policies to native GRANT/ROW
   POLICY (Option A).** Rejected for this goal: duplicates identity, can't
   express the app's policy model faithfully, splits audit. (Still the better
   choice if native-TCP CLI and max performance ever outweigh single-source-of-
   truth — could be a future ADR.)
2. **Expose ClickHouse directly with a shared read-only account.** Rejected: no
   per-user authz, no per-user audit, no data-access policies.
3. **Native-TCP-protocol gateway.** Rejected for v1: re-implementing ClickHouse's
   binary protocol is a large, ongoing effort. Revisit only if CLI demand is
   strong.

---

## Implementation plan (phased)

**Phase 0 — PAT subsystem (shared prerequisite).**
- Migration: `rbac_personal_access_tokens` (+ `VERSION_CHECKS` + dialect tests,
  per `CLAUDE.md`).
- Service: mint/verify/list/revoke, SHA-256 secret, cache + invalidation.
- API + UI (Preferences → Access Tokens), with audit events.

**Phase 1 — Query Gateway (HTTP, read paths).**
- New listener implementing the CH HTTP surface DataGrip's JDBC driver needs:
  `GET /ping`, version/handshake headers, `POST /` query execution, format
  negotiation, `X-ClickHouse-Summary`, gzip.
- PAT auth → resolve identity → reuse SQL parse + RBAC + data-access.
- Forward via service account with **pinned/stripped settings**; stream results.
- Wire audit + live-query registration + `query_id`/`quota_key`.

**Phase 2 — Writes + hardening.**
- Allowlisted DML/DDL gated by existing permissions; deny-list of escape hatches;
  multi-statement validation; per-PAT rate/concurrency limits; TLS/NetworkPolicy.

**Phase 3 — Private-cluster connectivity (optional).**
- Outbound-agent/sidecar (ch-ui-tunnel-style) for clusters the gateway can't
  reach inbound.

**Future work (not in scope here).**
- Native-TCP support (separate gateway or Option-A per-user accounts).
- Down-scoped downstream service role (super-admin-minus-dangerous-grants).

---

## Open questions

- Do we pin the downstream account to **read-only** for v1 and add writes behind
  an explicit permission in Phase 2?
- Should a PAT's **permission scope** default to **inherit-all** (the user's
  permissions on the bound connection), or **require** an explicit narrower
  subset (least privilege by default)? *(Connection binding itself is decided:
  always exactly one connection.)*
- Where do we draw the `system.*` allowlist line for legitimate engineer
  introspection vs. exfiltration?
