# ADR 0002 — Native ClickHouse access via an app-enforced Query Gateway

- **Status:** Proposed
- **Date:** 2026-06-16
- **Deciders:** CHouse UI maintainers
- **Tags:** RBAC, data-access, ClickHouse, connectivity, security
- **Depends on:** [ADR 0001 — Personal Access Tokens](./0001-personal-access-tokens.md)
- **Related:** `docs/datagrip-connection.md`, `docs/sso.md`

> **Scope split:** the credential this gateway authenticates with — the
> **Personal Access Token** — is specified separately in
> [ADR 0001](./0001-personal-access-tokens.md). This ADR assumes PATs exist
> (connection-bound, bounded-TTL, capped, verifiable via
> `verifyPersonalAccessToken`) and specifies the **gateway** that consumes them.

---

## Context

Today CHouse UI is the **only** path to ClickHouse, and **all security lives in
the application proxy layer**, not in ClickHouse:

1. **The browser never talks to ClickHouse.** The SPA calls the server
   (JWT-auth), which executes queries over **HTTP** (`@clickhouse/client`, port
   8123) using a **shared, server-side, AES-256-GCM-encrypted connection
   credential** (`rbac/services/connections.ts`). Connections are
   application-scoped; a user "sees" one only if a data-access policy on their
   role allows it.
2. **Enforcement happens in-process, before the query is sent:** RBAC permission
   checks (`rbac/middleware/rbacAuth.ts`, `middleware/dataAccess.ts`), SQL parsing
   (`middleware/sqlParser.ts`), data-access policies (regex/priority/allow-deny,
   `rbac/services/dataAccess.ts`), audit + query history, and the live-query view
   + kill (`services/clickhouse.ts`).
3. The app already manages real ClickHouse users, but those are a **separate
   identity space** we deliberately do **not** lean on here.

### The core tension

A native client (DataGrip, BI, `curl`) speaks ClickHouse's **wire protocol**
directly — **HTTP** (8123/8443) or **native TCP** (9000/9440). Connecting
straight to ClickHouse **bypasses every app-layer control** above. The question
is *not* "open a port" but **"where do authn/authz and audit live when the app is
no longer in the request path?"**

### What we want (the chosen product shape)

> Use the **app's** authentication, RBAC and data-access rules to govern queries
> from native tools. Keep the **live query view** and **data-access rule
> management** as the single control surface. Map to a **single super-admin
> service account on ClickHouse**, keep **all authn/authz + audit in the app**,
> and **do not replicate users or roles into ClickHouse**.

We run on **Kubernetes**, so sidecars / extra components are acceptable.

---

## Decision

Build a **ClickHouse Query Gateway**: an HTTP endpoint **wire-compatible with
ClickHouse's HTTP interface** that authenticates the caller with a **PAT
(ADR 0001)**, runs the **existing app enforcement pipeline** (RBAC → SQL parse →
data-access policy → audit/live-query), and forwards approved queries to the real
ClickHouse using **one shared super-admin service account**.

The gateway makes the app a **policy enforcement point (PEP) that speaks
ClickHouse**, so existing native tools point at it unchanged.

Concretely:

1. **PAT authentication** — the PAT (ADR 0001) is presented as the ClickHouse
   "password"/key; it resolves to the app user, the **bound connection**, and the
   effective permissions/data-access.
2. **Reuse, don't duplicate, enforcement** — the gateway calls the same
   `sqlParser` + `dataAccess` + audit + live-query modules the UI uses.
3. **Single service account** — downstream connection uses one privileged service
   credential (existing connection model). **No per-user ClickHouse users/roles.**
4. **App is the source of truth** for identity, authz and audit; ClickHouse only
   sees the service account, with per-user attribution injected
   (`log_comment`, `query_id`, `quota_key`).

### Why this (vs. pushing RBAC into ClickHouse)

Provisioning a native ClickHouse user/role per engineer and compiling app
policies into `GRANT`/`ROW POLICY` was rejected: it **splits the source of truth**
(sync/drift), **can't faithfully express** the app's regex/priority/deny model,
and **splits audit + live-query** from the single control surface.

**Trade-off accepted:** the gateway is **HTTP-only**, so the native-TCP
`clickhouse-client` CLI is **not** covered in v1 (see Consequences / Future work).
DataGrip and the broad HTTP/JDBC ecosystem are covered.

---

## Architecture

```
                          ┌──────────────────────────────────────────────┐
                          │                CHouse UI                       │
  ┌──────────┐  HTTP(S)   │  ┌───────────────┐     ┌──────────────────┐   │
  │ DataGrip │──────────► │  │ Query Gateway │────►│ Enforcement core │   │
  │  (JDBC)  │  PAT as    │  │ (CH HTTP API  │     │ • PAT auth (0001)│   │
  └──────────┘  password  │  │  compatible)  │     │ • RBAC perms     │   │
                          │  └───────┬───────┘     │ • SQL parse      │   │
  ┌──────────┐            │          │             │ • data-access    │   │
  │ BI / curl│──────────► │          │             │ • audit + live Q │   │
  └──────────┘            │          │ @clickhouse/client (HTTP 8123)      │
                          │          │ ONE shared super-admin service acct │
                          └──────────┼──────────────────────────────────── ┘
                                     ▼
                          ┌────────────────────┐
                          │     ClickHouse      │ (only the gateway can reach it;
                          │  system.query_log   │  NetworkPolicy + TLS)
                          └────────────────────┘
```

### Request flow

1. DataGrip opens HTTP(S) to the gateway with credentials (HTTP Basic or
   `X-ClickHouse-User`/`X-ClickHouse-Key`) and SQL in the body — as it would to
   ClickHouse.
2. Gateway extracts the **PAT** from the password/key, calls
   `verifyPersonalAccessToken` → app user + **bound connection** + effective
   permissions. The "user" field is informational; the **PAT is authoritative**.
3. Gateway **parses** the SQL → statement types + tables.
4. Gateway runs **RBAC permission** + **data-access policy** checks per
   statement/table (same code as the UI). Fail → ClickHouse-shaped error.
5. Approved → **forward** to the bound connection's ClickHouse via the service
   account, **pinning safe settings** and **stripping dangerous ones** (Security),
   streaming the result in the client's requested format (TabSeparated /
   JSONCompact / RowBinary…).
6. **Audit** + **register in the live-query view** with a server-issued
   `query_id` and per-user `quota_key`, so existing monitoring / **kill** works.

### Connection selection (carried by the PAT)

A user may access **multiple connections**, but a DataGrip data source is one
`(host, port, database, user, password)`. **The PAT is bound to exactly one
connection (ADR 0001)**, so the connection is determined by the credential:

- Fixed by the PAT's `connection_id`; any client routing hint naming a *different*
  connection is **rejected**.
- **One PAT — one data source — per connection.** Two clusters ⇒ two tokens.
- The bound connection must remain permitted by the user's data-access policies
  at query time; revoke access and the PAT stops working.
- Operators may expose a per-connection **host/subdomain** purely as ergonomics;
  it is not a selector. The JDBC **database** field selects a DB *within* the
  bound connection (orthogonal).

---

## Security considerations (critical — the gateway holds super-admin)

The downstream credential is a **super-admin service account**, so the gateway is
the *entire* security boundary; enforcement must be **fail-closed** and the SQL
parser is **load-bearing**, not defense-in-depth.

1. **Force-safe settings, strip client settings.** Inject/pin protective settings
   and ignore client overrides: pin `readonly` to the user's permission set; cap
   `max_execution_time`, `max_result_rows/bytes`, `max_memory_usage`,
   `max_rows_to_read`; never let the client set `log_comment`, `database`, or
   limit-relaxing settings. Maintain a **forwardable-settings allowlist**.
2. **Deny escape hatches** at parse time (deny-by-default): DCL/identity
   (`CREATE/ALTER/DROP USER|ROLE|QUOTA|ROW POLICY`, `GRANT`, `REVOKE`), `SYSTEM …`,
   data-exfil table functions (`url`, `file`, `s3`, `remote`, `jdbc`, `mysql`,
   `postgresql`, `hdfs`, dictionaries, `INTO OUTFILE`, `FROM INFILE`), and
   sensitive `system.*` reads unless explicitly permitted.
3. **Multi-statement safety.** Validate **every** statement; **parse-failure ⇒
   deny**. Constrain/reject `multiquery`.
4. **No raw passthrough.** No mode that skips parsing; unclassifiable ⇒ denied.
5. **Transport.** TLS on the gateway; mTLS/NetworkPolicy so **only** the gateway
   reaches ClickHouse's real ports. Never expose ClickHouse directly.
6. **Abuse limits.** Per-PAT rate limiting + concurrency caps; alert on repeated
   denials/auth failures.
7. **Unspoofable attribution.** `query_id`, `quota_key`, `log_comment` set
   server-side from the resolved identity.

> **Residual risk:** parser coverage *is* the boundary; new ClickHouse syntax can
> open holes. Mitigate with an **allowlist-first** posture and, where feasible, a
> down-scoped downstream service role ("super-admin minus dangerous grants").

---

## RBAC / permission changes

- **New gate `gateway:connect`** — whether a user may use native access *at all*.
  Minting a PAT (ADR 0001 `pat:create`) and using the gateway both require it, so
  an org can enable native access per role without touching data-access rules.
- **New admin gate `gateway:admin`** (`gateway:view` for read-only) — manage
  gateway settings (enable/disable, limits, settings allowlist, blocked
  functions).
- **Actual query authz is unchanged and reused:** existing `table:select`,
  `query:execute_ddl/dml`, etc. plus **data-access policies** decide what a
  request may do — no new query-level permissions.
- Add `gateway:*` to `schema/base.ts` `PERMISSIONS`, a `Connectivity / Gateway`
  category in `seed.ts`, and to frontend `RBAC_PERMISSIONS`. Grant `gateway:connect`
  to the roles that should reach native tools (proposed: `admin`, `developer`,
  `analyst`); `gateway:admin` → `admin` + `super_admin`. Adding to existing roles
  is a **grant migration** (with the data-migration test per `CLAUDE.md`).

---

## Audit & logging events

Reuse query history + live-query, and add a `gateway.*` namespace to
`AUDIT_ACTIONS` (`schema/base.ts`); server logs tagged `module: 'Gateway'`:

| Action | When | Notes |
|--------|------|-------|
| `gateway.query` | A statement is executed via the gateway | user, `tokenId`, connection, `query_id`, statement type, tables, row/byte counts, duration |
| `gateway.query_denied` | RBAC/data-access/parse rejects a statement | user, `tokenId`, reason, offending table/operation — security signal |
| `gateway.auth_failed` | Bad/missing/expired PAT at the gateway | correlates with ADR 0001 `pat.use_failed` |
| `gateway.settings_update` | Admin changes gateway config | actor + diff |

- Every gateway query carries the originating **`tokenId`** (ADR 0001) and the
  resolved **user**, so the **Audit** and **Query History** screens attribute
  native-tool traffic to a person, not the service account.
- The **live-query view** registers gateway queries with the server-issued
  `query_id`, so admins can watch and **kill** them exactly like UI queries.

---

## UI changes

- **Connection details / "Native access" panel (per connection):** in the
  connection view, a section showing the **gateway endpoint** (host/port, TLS),
  how to connect, a **"Create access token"** shortcut (deep-link to ADR 0001's
  Preferences → Access Tokens, pre-selecting this connection), and a link to the
  [DataGrip guide](../datagrip-connection.md). Gated on `gateway:connect`.
- **Live Query view:** add a **source/origin** indicator + filter
  (`UI` vs `Gateway/PAT`) and show the **token name + user** for gateway queries,
  reusing existing kill controls.
- **Audit view:** the new `gateway.*` actions appear automatically; add them to
  the action filter list.
- **Admin → Gateway settings (gated on `gateway:admin`):** enable/disable the
  gateway, view/edit limits (rate/concurrency, result/row caps), the forwardable-
  settings allowlist and blocked-function list, and the bound service account per
  connection. Read-only when config-sourced (mirrors the SSO settings pattern).
- **API client (`src/api/rbac.ts`):** `gatewayApi` (settings get/update; the
  per-connection native-access info). Token CRUD lives in ADR 0001's `patApi`.

---

## Kubernetes deployment options

**A. In-process listener (recommended v1).** A second route/port on the existing
Bun + Hono server; shares enforcement code + DB. Expose via a dedicated
`Service` + `Ingress`/`Gateway` with TLS.

**B. Dedicated gateway Deployment.** Same image, `gateway`-only role, scaled and
network-isolated independently; needs shared RBAC DB + encryption keys.

**C. Connectivity sidecar / outbound agent (private clusters).** When ClickHouse
isn't reachable inbound, run a small **outbound-only agent** beside ClickHouse
that dials back to the gateway — the pattern
[ch-ui's "Remote ClickHouse Tunnel"](#evaluation-ch-ui-remote-clickhouse-tunnel)
uses. Keeps ClickHouse ports off the internet.

**Optional `chproxy` sidecar** between gateway and ClickHouse for pooling/quota
routing — operational only; it does **not** replace app enforcement.

### Evaluation: ch-ui "Remote ClickHouse Tunnel"

`caioricciuti/ch-ui`'s tunnel is a **secure WebSocket relay** (`wss://`), **not** a
TCP/SSH tunnel: a **server** (UI) + a lightweight **agent** (`ch-ui connect`) beside
ClickHouse; the **agent dials out** to the server's `/connect` endpoint
(outbound-only), token-authed (`cht_…`, `ch-ui tunnel create|rotate`), installable
as an OS service or Docker sidecar, talking **local ClickHouse over HTTP 8123**.

**Borrow:** the **outbound-agent + token** pattern for "reach a ClickHouse we can't
route to inbound" (option C); it validates the **HTTP-8123 + opaque-token**
approach. **Doesn't solve for us:** it connects *the UI server* to ClickHouse — it
does **not** authenticate *external native clients* as app users with app-enforced
authz. So it's a **complementary transport**, not the enforcement design.

---

## Consequences

### Positive
- One control surface: existing **RBAC, data-access, audit, live-query** govern
  native-tool traffic; **no second policy engine**, **no user/role replication**.
- Works with the **HTTP/JDBC** ecosystem (DataGrip, BI, `curl`).
- Per-query **attribution** (to a person) and **kill** keep working.

### Negative / accepted
- **HTTP-only in v1** → native-TCP `clickhouse-client` CLI unsupported (Future work).
- A **single high-value boundary** in front of super-admin — parser/allowlist
  correctness is security-critical and needs upkeep as ClickHouse evolves.
- **Performance:** all native traffic flows through the app (mitigated by
  streaming + optional `chproxy`).

---

## Alternatives considered

1. **Per-user ClickHouse users + compile policies to GRANT/ROW POLICY.** Rejected:
   duplicates identity, can't express the policy model, splits audit. (Could be a
   future ADR if native-TCP + max perf ever outweigh single-source-of-truth.)
2. **Expose ClickHouse directly with a shared account.** Rejected: no per-user
   authz/audit/data-access.
3. **Native-TCP-protocol gateway.** Rejected for v1: reimplementing the binary
   protocol is a large, ongoing effort.

---

## Implementation plan (phased)

**Prereq — ADR 0001 (PAT)** shipped: `verifyPersonalAccessToken`, connection
binding, limits.

**Phase 1 — Gateway (HTTP, read paths).** Listener implementing the CH HTTP
surface DataGrip's JDBC driver needs (`GET /ping`, version/handshake headers,
`POST /` execution, format negotiation, `X-ClickHouse-Summary`, gzip); PAT auth →
identity; reuse SQL parse + RBAC + data-access; forward via service account with
**pinned/stripped settings**; stream; wire **audit + live-query** + `query_id`/`quota_key`.

**Phase 2 — Writes + hardening.** Allowlisted DML/DDL gated by existing perms;
escape-hatch deny-list; multi-statement validation; per-PAT rate/concurrency
limits; TLS/NetworkPolicy; `gateway:*` permissions + admin settings UI.

**Phase 3 — Private-cluster connectivity (optional).** Outbound-agent/sidecar.

**Cross-cutting (each phase):** UI (native-access panel, live-query origin filter,
audit actions, admin settings), `gateway.*` audit, docs, changelog.

**Future work.** Native-TCP support (separate gateway or per-user accounts);
down-scoped downstream service role.

---

## Open questions

- Pin the downstream account to **read-only** in v1 and add writes behind a
  permission in Phase 2?
- `system.*` allowlist line for legitimate engineer introspection vs. exfiltration?
- Should `gateway:connect` be granted by default to `analyst`/`developer`, or be
  opt-in per deployment?
