# Connecting JetBrains DataGrip to ClickHouse through CHouse UI

> **Status:** this guide describes the experience delivered by two proposed
> features: the **Query Gateway**
> ([ADR 0002](./adr/0002-clickhouse-query-gateway.md)) and the **Personal Access
> Tokens** it depends on ([ADR 0001](./adr/0001-personal-access-tokens.md)).
> It documents the intended workflow; sections marked _(planned)_ land with those
> features.

CHouse UI can act as a **ClickHouse-compatible HTTP endpoint** so you can use
DataGrip (or any HTTP/JDBC ClickHouse tool) while still going through the app's
authentication, RBAC and data-access rules — and having every query show up in
the **live query view** and **audit log**.

You connect to the **gateway**, not to ClickHouse. You authenticate with a
**Personal Access Token**, not your login password. Behind the scenes the
gateway checks your permissions and forwards approved queries to ClickHouse.

---

## 1. Create a Personal Access Token _(planned)_

1. In CHouse UI, open **Preferences → Access Tokens**.
2. Click **Create token** and set:
   - a **name** (e.g. `datagrip-prod`),
   - the **connection** this token is for — **required**; each token works
     against exactly one connection, so mint one per cluster you need,
   - an **expiry** within the allowed range (minimum **5 minutes**; the maximum
     is set by your admin — there are no never-expiring tokens),
   - optionally a narrower **permission scope** (e.g. read-only).
3. Copy the token **immediately** — it looks like `chpat_AbC123_…` and is shown
   **only once**. Store it in your password manager.

A token carries *your* identity and *your* permissions on its connection. Treat
it like a password: don't share it, and revoke it from the same screen if it
leaks. There's a per-user limit on how many active tokens you can hold (set by
your admin); if you hit it, revoke an old one first.

---

## 2. Gather connection details

Ask your administrator for the **gateway host** (and port). It will look like:

| Field | Example |
|-------|---------|
| Host  | `chouse.your-company.com` |
| Port  | `443` (HTTPS) — or the gateway port your admin assigns |
| SSL   | **on** (always use TLS) |
| User  | your CHouse UI **username or email** (informational) |
| Password | your **PAT** (`chpat_…`) |
| Database | the database you want as default (e.g. `default`) |

---

## 3. Add the data source in DataGrip

1. **File → New → Data Source → ClickHouse.**
   - If prompted, let DataGrip download the **ClickHouse driver** (the JDBC
     driver that talks over HTTP).
2. On the **General** tab:
   - **Host:** the gateway host (e.g. `chouse.your-company.com`)
   - **Port:** the gateway port (e.g. `443`)
   - **User:** your CHouse UI username/email
   - **Password:** paste your **PAT** (`chpat_…`); tick **Save password**
   - **Database:** e.g. `default`
3. On the **SSH/SSL** tab: enable **Use SSL** (the gateway requires TLS).
4. Click **Test Connection**. On success you'll see the ClickHouse server
   version (reported by the gateway).

### JDBC URL (if you prefer to set it manually)

```
jdbc:clickhouse://chouse.your-company.com:443/default?ssl=true
```

- **User** = your CHouse UI username/email
- **Password** = your PAT

> The gateway speaks ClickHouse's **HTTP** interface, so use the standard
> ClickHouse JDBC driver (HTTP transport). The native-TCP `clickhouse-client`
> CLI is **not** supported via the gateway — see _Limitations_.

---

## 3a. Working with more than one connection

Your CHouse UI account may have access to **several connections** (each is a
different ClickHouse cluster). You **don't** select the connection in DataGrip —
**each token is bound to one connection**, so the connection is decided by which
token you use:

- Create **one data source per connection**, each authenticated with the PAT you
  minted for that connection.
- To reach a second cluster, mint a second token (scoped to that connection) and
  add a second data source.
- Revoking a token only affects its connection.

Your admin may also give each connection a friendly **hostname** (e.g.
`prod.chouse.your-company.com`) to make the data sources easy to tell apart — but
that's just cosmetic; the token is what determines the connection.

> The **Database** field is *not* the connection — it picks a database *inside*
> the token's connection. They're two separate things.

---

## 4. Recommended DataGrip settings

DataGrip runs background **introspection** queries to populate its schema tree.
A few of those touch `system.*` tables the gateway may restrict. To keep things
smooth:

- **Options → Introspect using JDBC metadata:** prefer this if full native
  introspection hits permission errors.
- **Schemas tab:** select only the databases you actually need (avoid scanning
  everything).
- If a background query is denied, it reflects **your data-access policy** — the
  same rules the UI enforces. Ask an admin to adjust the policy if you need a
  database/table you can't see.
- Turn off auto-running heavy "database objects" refreshes if your token is
  rate-limited.

---

## 5. What the gateway enforces (so there are no surprises)

Every statement you run is, server-side:

1. **Authenticated** via your PAT → resolved to your CHouse UI user.
2. **Parsed**, and checked against your **RBAC permissions** (e.g. you can
   `SELECT` but not `DROP`).
3. **Checked against data-access policies** — you can only touch the
   databases/tables your role allows.
4. **Forwarded** to ClickHouse under the app's service account, with resource
   limits applied (max rows / time / memory).
5. **Audited** and shown in the **live query view**, where an admin can watch or
   **kill** it — exactly like a query run from the UI.

If a query is rejected you'll get a ClickHouse-style error describing why
(e.g. permission denied for `table:drop`, or table not permitted by policy).

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Authentication failed` | Wrong/expired/revoked PAT | Mint a new token; check expiry |
| Connects but schema tree is empty | Data-access policy hides those DBs/tables | Ask admin to grant access via a policy |
| `Operation not permitted` on a write | Your role lacks `table:insert` / DDL perms | Request the permission, or use a read tool |
| Some `system.*` queries fail | Gateway restricts sensitive system tables | Expected; use permitted introspection |
| `Too many requests` | Per-token rate limit | Slow background refresh; or use a dedicated token |
| TLS errors | SSL not enabled / cert trust | Enable **Use SSL**; import the CA if self-signed |

---

## Limitations

- **HTTP/JDBC tools only.** The native-TCP `clickhouse-client` CLI is not
  supported through the gateway in this iteration (it speaks ClickHouse's binary
  protocol on port 9000). HTTP-based clients — DataGrip, BI tools, `curl` — are
  supported. See [ADR 0002 → Future work](./adr/0002-clickhouse-query-gateway.md#implementation-plan-phased).
- **Your token = your permissions.** A PAT can never do more than your CHouse UI
  user can; scope it down for tools that only need to read.
