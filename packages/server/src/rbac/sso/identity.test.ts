import { describe, it, expect, mock, beforeEach } from "bun:test";

// In-memory store — shared across all builder closures so mutations are visible
let store: Record<string, unknown>[] = [];

// ------------------------------------------------------------------
// Parse a real Drizzle SQL condition object into simple key-value pairs
// for in-memory filtering.
//
// Drizzle SQL object shape (verified at runtime):
//   eq(col, val) → SQL{ queryChunks: [StringChunk, ColObj{name,columnType}, StringChunk, Param{value,encoder}, StringChunk] }
//   and(...eqs)  → SQL{ queryChunks: [StringChunk("("), SQL{ queryChunks:[eq1, StringChunk(" and "), eq2] }, StringChunk(")")] }
// ------------------------------------------------------------------

type KvMap = Record<string, unknown>;

function isSqlObj(c: unknown): c is { queryChunks: unknown[] } {
  return typeof c === "object" && c !== null && "queryChunks" in c && Array.isArray((c as { queryChunks: unknown }).queryChunks);
}

function isColObj(c: unknown): c is { name: string; columnType: string } {
  return (
    typeof c === "object" &&
    c !== null &&
    "name" in c &&
    "columnType" in c &&
    typeof (c as { name: unknown }).name === "string" &&
    !("queryChunks" in c)
  );
}

function isParamObj(c: unknown): c is { value: unknown } {
  return (
    typeof c === "object" &&
    c !== null &&
    "value" in c &&
    "encoder" in c &&
    !("queryChunks" in c) &&
    !("columnType" in c)
  );
}

/** Recursively extract all col = val pairs from a Drizzle SQL condition tree */
function extractConditions(cond: unknown): KvMap {
  if (!isSqlObj(cond)) return {};
  const result: KvMap = {};
  const chunks = cond.queryChunks;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (isColObj(chunk)) {
      // Scan forward for the Param value (skip StringChunks)
      for (let j = i + 1; j < chunks.length; j++) {
        const next = chunks[j];
        if (isParamObj(next)) {
          result[chunk.name] = next.value;
          break;
        }
        if (isColObj(next) || isSqlObj(next)) break;
      }
    } else if (isSqlObj(chunk)) {
      Object.assign(result, extractConditions(chunk));
    }
  }

  return result;
}

function matchesCondition(row: Record<string, unknown>, cond: unknown): boolean {
  if (!cond) return true;
  const kvs = extractConditions(cond);
  if (Object.keys(kvs).length === 0) return true; // no parseable conditions — pass all
  return Object.entries(kvs).every(([sqlCol, v]) => {
    // Translate SQL column name to JS field name (e.g. "user_id" → "userId")
    const jsKey = sqlToJsField[sqlCol] ?? sqlCol;
    return row[jsKey] === v;
  });
}

// ------------------------------------------------------------------
// Fake Drizzle DB — operates on the in-memory `store` array
// ------------------------------------------------------------------

function makeSelectBuilder(projection?: Record<string, unknown>): Record<string, unknown> {
  let condition: unknown = null;
  let limitVal: number | undefined;

  const resolve = () => {
    let rows = store.filter((r) => matchesCondition(r, condition));
    if (limitVal !== undefined) rows = rows.slice(0, limitVal);
    if (projection) {
      // For { id: schema.userIdentities.id } style projections, just return id field
      return rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const alias of Object.keys(projection)) {
          out[alias] = r[alias];
        }
        return out;
      });
    }
    return rows;
  };

  const builder: Record<string, unknown> = {};

  builder.from = mock((_table: unknown) => builder);

  builder.where = mock((cond: unknown) => {
    condition = cond;
    return builder;
  });

  builder.limit = mock((n: number) => {
    limitVal = n;
    return builder;
  });

  // Make the builder thenable so `await builder` resolves
  builder.then = mock((resolve2: (v: unknown) => void, _reject?: unknown) =>
    resolve2(resolve())
  );

  return builder;
}

function makeInsertBuilder(): Record<string, unknown> {
  const builder: Record<string, unknown> = {
    values: mock((row: Record<string, unknown>) => {
      store.push({ ...row });
      return builder;
    }),
    then: mock((resolve: (v: unknown) => void) => resolve(undefined)),
  };
  return builder;
}

function makeUpdateBuilder(): Record<string, unknown> {
  let updates: Record<string, unknown> = {};
  let condition: unknown = null;

  const apply = () => {
    const targets = store.filter((r) => matchesCondition(r, condition));
    for (const row of targets) {
      Object.assign(row, updates);
    }
  };

  const builder: Record<string, unknown> = {
    set: mock((vals: Record<string, unknown>) => {
      updates = vals;
      return builder;
    }),
    where: mock((cond: unknown) => {
      condition = cond;
      apply();
      return builder;
    }),
    then: mock((resolve: (v: unknown) => void) => resolve(undefined)),
  };

  return builder;
}

const mockDb = {
  select: mock((projection?: Record<string, unknown>) => makeSelectBuilder(projection)),
  insert: mock((_table: unknown) => makeInsertBuilder()),
  update: mock((_table: unknown) => makeUpdateBuilder()),
};

// Use real sqlite schema columns so that eq(schema.userIdentities.provider, ...) produces
// a proper Drizzle SQL object that our extractConditions() can parse.
import * as sqliteSchema from "../schema/sqlite";

// Build a mapping from SQL column name → JS field name for userIdentities
// (e.g. "user_id" → "userId") so matchesCondition can look up rows correctly.
const sqlToJsField: Record<string, string> = {};
for (const [jsKey, col] of Object.entries(sqliteSchema.userIdentities)) {
  if (col && typeof col === "object" && "name" in col && typeof (col as { name: unknown }).name === "string") {
    sqlToJsField[(col as { name: string }).name] = jsKey;
  }
}

mock.module("../db", () => ({
  getDatabase: () => mockDb,
  getSchema: () => sqliteSchema,
  isSqlite: () => true,
}));

// ------------------------------------------------------------------
// Import the module under test (after mocks are registered)
// ------------------------------------------------------------------

import {
  createUserIdentity,
  getUserIdentity,
  userHasSsoIdentity,
  touchUserIdentity,
} from "./identity";

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe("SSO Identity Store", () => {
  beforeEach(() => {
    store = [];
    mockDb.select.mockClear();
    mockDb.insert.mockClear();
    mockDb.update.mockClear();
  });

  describe("createUserIdentity + getUserIdentity", () => {
    it("round-trips: created identity is retrievable by provider+subject", async () => {
      await createUserIdentity({
        userId: "u1",
        provider: "okta",
        subject: "sub-1",
        email: "a@b.co",
      });

      const row = await getUserIdentity("okta", "sub-1");

      expect(row).not.toBeNull();
      expect(row!.userId).toBe("u1");
      expect(row!.provider).toBe("okta");
      expect(row!.subject).toBe("sub-1");
      expect(row!.email).toBe("a@b.co");
    });

    it("createUserIdentity returns the identity with a generated id", async () => {
      const identity = await createUserIdentity({
        userId: "u2",
        provider: "github",
        subject: "sub-2",
      });

      expect(typeof identity.id).toBe("string");
      expect(identity.id.length).toBeGreaterThan(0);
      expect(identity.userId).toBe("u2");
    });
  });

  describe("getUserIdentity", () => {
    it("returns null when no matching subject exists", async () => {
      await createUserIdentity({ userId: "u1", provider: "okta", subject: "sub-1" });

      const result = await getUserIdentity("okta", "nope");

      expect(result).toBeNull();
    });

    it("returns null on an empty store", async () => {
      const result = await getUserIdentity("okta", "nonexistent");
      expect(result).toBeNull();
    });

    it("does not return an identity from a different provider", async () => {
      await createUserIdentity({ userId: "u1", provider: "okta", subject: "sub-1" });

      const result = await getUserIdentity("github", "sub-1");
      expect(result).toBeNull();
    });
  });

  describe("userHasSsoIdentity", () => {
    it("returns false before any identity is created for user", async () => {
      const result = await userHasSsoIdentity("u1");
      expect(result).toBe(false);
    });

    it("returns true after an identity is created for user", async () => {
      await createUserIdentity({ userId: "u1", provider: "okta", subject: "sub-1" });

      const result = await userHasSsoIdentity("u1");
      expect(result).toBe(true);
    });

    it("returns false for a different userId even after identities exist", async () => {
      await createUserIdentity({ userId: "u1", provider: "okta", subject: "sub-1" });

      const result = await userHasSsoIdentity("u99");
      expect(result).toBe(false);
    });
  });

  describe("touchUserIdentity", () => {
    it("updates lastLoginAt on the matching identity and update was called", async () => {
      const identity = await createUserIdentity({
        userId: "u1",
        provider: "okta",
        subject: "sub-1",
      });

      // Slight pause to ensure a later timestamp is observable
      await new Promise((r) => setTimeout(r, 2));

      await touchUserIdentity(identity.id);

      expect(mockDb.update).toHaveBeenCalled();
      const updated = await getUserIdentity("okta", "sub-1");
      expect(updated).not.toBeNull();
      // lastLoginAt should be non-null after the touch
      expect(updated!.lastLoginAt).not.toBeNull();
    });

    it("does not affect other identities in the store", async () => {
      const id1 = await createUserIdentity({ userId: "u1", provider: "okta", subject: "s1" });
      await createUserIdentity({ userId: "u2", provider: "okta", subject: "s2" });

      await touchUserIdentity(id1.id);

      const row2 = await getUserIdentity("okta", "s2");
      expect(row2).not.toBeNull();
      expect(row2!.userId).toBe("u2");
    });
  });
});
