# Connecting JetBrains DataGrip to ClickHouse through CHouse UI

> **Status:** this guide describes the experience delivered by the **Query
> Gateway + Personal Access Token (PAT)** feature proposed in
> [ADR 0001](./adr/0001-native-clickhouse-access-via-query-gateway-and-pat.md).
> It documents the intended workflow; sections marked _(planned)_ land with that
> feature.

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
2. Click **Create token**. Give it a name (e.g. `datagrip-laptop`), an optional
   expiry, and an optional scope (e.g. limit it to one connection / read-only).
3. Copy the token **immediately** — it looks like `chpat_AbC123_…` and is shown
   **only once**. Store it in your password manager.

A token carries *your* identity and *your* permissions. Treat it like a
password: don't share it, and revoke it from the same screen if it leaks.

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

## 3a. Choosing which connection (when you have more than one)

Your CHouse UI account may have access to **several connections** (each is a
different ClickHouse cluster). A DataGrip data source maps to **one** connection.
Pick whichever of these fits — they're listed easiest-first:

**Option 1 — a connection-scoped token (recommended).** When you mint the PAT,
scope it to a single connection. Then there's nothing to configure here: the
gateway routes by the token. Create one data source per connection, each with its
own scoped PAT. Bonus: revoking that token only affects that connection.

**Option 2 — name the connection on the data source.** If you use one unscoped
token across connections, tell the gateway which connection this data source
targets. In **Advanced** (driver properties), add **one** of:

| Driver property | Value |
|-----------------|-------|
| `custom_http_headers` | `X-CHouse-Connection=prod` |
| `custom_http_params`  | `chouse_connection=prod` |

(`prod` is the connection's slug — ask your admin or copy it from the connection
list in CHouse UI. Both properties are comma-separated if you ever add more.)

**Option 3 — a per-connection host.** Your admin may give each connection its own
hostname (e.g. `prod.chouse.your-company.com`). Just use that host and the
connection is implied — no extra fields.

> The **Database** field is *not* the connection — it picks a database *inside*
> the chosen connection. Selecting the connection (above) and the default
> database are two separate things.
>
> If you have multiple connections and don't scope/select one, the gateway
> returns an error listing your available connection slugs so you can pick.

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
  supported. See [ADR 0001 → Future work](./adr/0001-native-clickhouse-access-via-query-gateway-and-pat.md#implementation-plan-phased).
- **Your token = your permissions.** A PAT can never do more than your CHouse UI
  user can; scope it down for tools that only need to read.
