/**
 * SSO Provisioning Service
 *
 * Turns a verified SSO identity into a local user + session:
 *   1. existing identity link -> that user
 *   2. else verified-email match (when auto_link_by_email) -> link + that user
 *   3. else JIT-create with default role
 * Providers with role_mapping re-sync roles on every login.
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { getDatabase, getSchema } from '../db';
import {
  createSessionAndTokens,
  createUser,
  getUserByEmail,
  getUserByUsername,
  getRoleByName,
  getUserRoles,
} from '../services/rbac';
import { getUserIdentity, createUserIdentity, touchUserIdentity } from './identity';
import { getSsoConfig, type SsoProviderConfig } from './config';
import type { SsoIdentity } from './client';
import { logger } from '../../utils/logger';
import { AppError } from '../../types';
import type { User, UserResponse } from '../schema';
import type { TokenPair } from '../services/jwt';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export async function provisionSsoUser(
  provider: SsoProviderConfig,
  identity: SsoIdentity,
  ipAddress?: string,
  userAgent?: string
): Promise<{ user: UserResponse; tokens: TokenPair }> {
  const config = getSsoConfig();
  const db = getDatabase() as AnyDb;
  const schema = getSchema();

  let user: User | null = null;

  // 1. Existing identity link
  const existing = await getUserIdentity(provider.id, identity.subject);
  if (existing) {
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, existing.userId))
      .limit(1);
    user = rows[0] || null;
    if (user) await touchUserIdentity(existing.id);
  }

  // 2. Link by verified email
  if (!user && config.autoLinkByEmail && identity.email && identity.emailVerified) {
    const byEmail = await getUserByEmail(identity.email);
    if (byEmail) {
      await createUserIdentity({
        userId: byEmail.id,
        provider: provider.id,
        subject: identity.subject,
        email: identity.email,
      });
      user = byEmail;
      logger.info(
        { module: 'SSO', provider: provider.id, userId: byEmail.id },
        'Linked SSO identity to existing user by email'
      );
    }
  }

  // 3. JIT create
  if (!user) {
    if (!identity.email) {
      throw AppError.unauthorized(
        'Your identity provider did not supply an email address; cannot create an account.'
      );
    }
    const username = await pickAvailableUsername(identity.username || identity.email.split('@')[0]);
    const defaultRole = await getRoleByName(config.defaultRole);
    const created = await createUser({
      email: identity.email,
      username,
      // Random unusable password — SSO users authenticate at the IdP.
      password: `${randomUUID()}Aa1!${randomUUID()}`,
      displayName: identity.displayName || username,
      roleIds: defaultRole ? [defaultRole.id] : [],
    });
    await createUserIdentity({
      userId: created.id,
      provider: provider.id,
      subject: identity.subject,
      email: identity.email,
    });
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, created.id))
      .limit(1);
    user = rows[0] || null;
    logger.info(
      { module: 'SSO', provider: provider.id, userId: created.id },
      'JIT-provisioned user from SSO login'
    );
  }

  if (!user || !user.isActive) {
    throw AppError.unauthorized('This account is inactive.');
  }

  // Optional role sync
  if (provider.roleMapping && provider.roleMappingClaim) {
    await syncMappedRoles(user.id, provider, identity.claims);
  }

  return createSessionAndTokens(user, ipAddress, userAgent);
}

/** Lowercase, strip disallowed chars, suffix 2,3,... on collision. */
async function pickAvailableUsername(base: string): Promise<string> {
  const sanitized =
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 64) || 'user';
  let candidate = sanitized;
  for (let i = 2; await getUserByUsername(candidate); i++) {
    candidate = `${sanitized}${i}`;
  }
  return candidate;
}

/**
 * Replace the user's roles with those mapped from the IdP claim.
 * If no mapped role resolves to a known role, keep existing roles (avoid lockout).
 */
async function syncMappedRoles(
  userId: string,
  provider: SsoProviderConfig,
  claims: Record<string, unknown>
): Promise<void> {
  const raw = claims[provider.roleMappingClaim as string];
  const values: string[] = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? [raw]
      : [];
  const mapping = provider.roleMapping as Record<string, string>;

  const targetRoleNames = [...new Set(values.map((v) => mapping[v]).filter(Boolean))];
  const targetRoles = (
    await Promise.all(targetRoleNames.map((n) => getRoleByName(n)))
  ).filter((r): r is NonNullable<typeof r> => r !== null);

  if (targetRoles.length === 0) {
    logger.warn(
      { module: 'SSO', provider: provider.id, userId, claimValues: values },
      'Role mapping produced no known roles; keeping existing roles'
    );
    return;
  }

  const currentNames = await getUserRoles(userId);
  const targetNames = targetRoles.map((r) => r.name).sort();
  if (JSON.stringify([...currentNames].sort()) === JSON.stringify(targetNames)) return;

  const db = getDatabase() as AnyDb;
  const schema = getSchema();
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
  await db.insert(schema.userRoles).values(
    targetRoles.map((role) => ({
      id: randomUUID(),
      userId,
      roleId: role.id,
      assignedAt: new Date(),
      assignedBy: `sso:${provider.id}`,
    }))
  );
  logger.info(
    { module: 'SSO', provider: provider.id, userId, roles: targetNames },
    'Synced roles from IdP claim'
  );
}
