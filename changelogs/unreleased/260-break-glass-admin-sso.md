type: minor

### Added
- **Break-glass admin excluded from SSO by default** — the seeded local administrator is now a break-glass account that is never auto-linked, JIT-provisioned, or role-synced by an identity provider, and always keeps password login (even when password sign-in is globally disabled). The login page exposes an "Administrator break-glass sign-in" link to reach the form when SSO is enforced. Opt in with `AUTH_ADMIN_SSO_ENABLED=true` (`auth.admin_sso.enabled`) to manage the admin via SSO instead.

### Changed
- **SSO admin settings** now surface the break-glass admin status (read-only) so operators can see whether the local admin is excluded from or opted into SSO.
