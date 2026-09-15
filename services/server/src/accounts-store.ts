import { randomUUID } from "node:crypto";

import { conflict, invalidInput, MissionGoError, notFound } from "./errors.js";
import { hashPassword, verifyPassword, type AccountRole } from "./admin-auth.js";
import type { MissionGoDatabase } from "./storage/database.js";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1_024;
/** How stale "last used" is allowed to get, so reading does not cost a write every time. */
export const AI_AUTHORIZATION_TOUCH_INTERVAL_MS = 5 * 60_000;

/**
 * What an account may do with one product.
 *
 * Three independent switches, not a ranked scale. "Read it in the console but
 * keep AI clients out of it" is a real answer, and a scale cannot say it.
 * `operate` and `ai` each imply `view`, which is enforced when a permission is
 * written rather than when it is read, so a stored row always makes sense on
 * its own.
 */
export interface ProductPermission {
  readonly productId: string;
  readonly canView: boolean;
  readonly canOperate: boolean;
  readonly canUseAi: boolean;
}

export type ProductCapability = "view" | "operate" | "ai";

/** One account's standing on one product, as the product-side editor shows it. */
export interface ProductAccessEntry {
  readonly account: AccountSnapshot;
  readonly permission: ProductPermission;
  /** True for an administrator, who reaches the product whatever the row says. */
  readonly reachesByRole: boolean;
}

export interface AccountSnapshot {
  readonly id: string;
  readonly email: string;
  readonly role: AccountRole;
  /** Set when the account is suspended. Its sessions and AI tokens stop working. */
  readonly disabledAt?: string;
  /**
   * When the password last changed or the account was suspended. Sessions and AI
   * tokens issued before this are refused, which is how "sign out everywhere"
   * works without a sessions table.
   */
  readonly credentialsChangedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AccountRow {
  id: string;
  email: string;
  password_scrypt: string;
  role: AccountRole;
  credentials_changed_at: string;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One AI client's standing authorization, as the console lists it. */
export interface AiAuthorizationSnapshot {
  readonly id: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt?: string;
}

interface AiAuthorizationRow {
  id: string;
  client_id: string;
  scopes_json: string;
  issued_at: string;
  expires_at: string;
  last_used_at: string | null;
}

interface PermissionRow {
  product_id: string;
  can_view: number;
  can_operate: number;
  can_use_ai: number;
}

// Deliberately loose. The point is to catch a typo, not to adjudicate what the
// RFC permits; a real address proves itself by receiving mail, and nothing here
// sends any.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(value: string): string {
  const email = value.trim();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw invalidInput("Enter a valid email address.");
  return email;
}

function assertPassword(value: string): string {
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw invalidInput(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (value.length > MAX_PASSWORD_LENGTH) throw invalidInput("Password is too long.");
  return value;
}

export class AccountStore {
  constructor(private readonly database: MissionGoDatabase) {}

  /**
   * Put the configured administrator in the table, once, and give it everything
   * the environment used to grant it directly.
   *
   * This is not a schema migration. The id, email and password hash come from
   * the server's configuration, which the database layer cannot see, and a
   * migration row would record "done" for a database that never received one.
   * It runs on every start instead and does nothing once any account exists --
   * so an administrator who later changes their own password or email keeps the
   * change across restarts, and the environment does not quietly put it back.
   *
   * The id is reused rather than generated. `nodes`, `dispatches`,
   * `work_item_events` and `work_item_comments` already carry it; a fresh id
   * would orphan every machine, every dispatch and every attribution recorded
   * so far.
   */
  seedBootstrapAdmin(input: {
    readonly id: string;
    readonly email: string;
    readonly passwordScrypt: string;
    readonly authorizedProductIds?: readonly string[];
  }): void {
    const existing = this.database.connection
      .prepare("SELECT COUNT(*) AS total FROM accounts")
      .get() as unknown as { total: number };
    if (existing.total > 0) return;

    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.connection
        .prepare(
          `INSERT INTO accounts (id, email, password_scrypt, role, credentials_changed_at, created_at, updated_at)
           VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
        )
        .run(input.id, input.email.trim(), input.passwordScrypt, now, now, now);
      // Everything already in the database was created by the only account that
      // existed, so it owns all of it.
      this.database.connection
        .prepare("UPDATE products SET created_by_account_id = ? WHERE created_by_account_id IS NULL")
        .run(input.id);
      // ADMIN_AUTHORIZED_PRODUCT_IDS narrowed what AI clients could read. It
      // becomes permission rows and stops being consulted; leaving it in two
      // places is how the two drift apart. An unset variable meant every
      // product, and an administrator reaches every product by role, so there
      // is nothing to write in that case.
      for (const productId of input.authorizedProductIds ?? []) {
        this.database.connection
          .prepare(
            `INSERT OR IGNORE INTO account_products
               (account_id, product_id, can_view, can_operate, can_use_ai, created_at, updated_at)
             VALUES (?, ?, 1, 1, 1, ?, ?)`,
          )
          .run(input.id, productId, now, now);
      }
    });
  }

  listAccounts(): readonly AccountSnapshot[] {
    const rows = this.database.connection
      .prepare("SELECT * FROM accounts ORDER BY role = 'member', email")
      .all() as unknown as AccountRow[];
    return rows.map((row) => mapAccount(row));
  }

  getAccount(accountId: string): AccountSnapshot {
    const row = this.row(accountId);
    if (!row) throw notFound("Account");
    return mapAccount(row);
  }

  createAccount(input: { email: string; password: string; role: AccountRole }): AccountSnapshot {
    const email = normalizeEmail(input.email);
    const password = assertPassword(input.password);
    if (input.role !== "admin" && input.role !== "member") throw invalidInput("Account role must be admin or member.");
    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      this.database.connection
        .prepare(
          `INSERT INTO accounts (id, email, password_scrypt, role, credentials_changed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, email, hashPassword(password), input.role, now, now, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw conflict("account_email_conflict", "That email address already has an account.");
      }
      throw error;
    }
    return this.getAccount(id);
  }

  /**
   * Change role, suspend, or reset the password on someone else's behalf.
   *
   * Suspending and resetting both move `credentials_changed_at`: an account that
   * has just been suspended still holds a signed session cookie, and a password
   * the owner did not choose has to invalidate whatever the old one issued.
   */
  updateAccount(
    accountId: string,
    input: { email?: string; role?: AccountRole; disabled?: boolean; password?: string },
  ): AccountSnapshot {
    const current = this.getAccount(accountId);
    if (input.role !== undefined && input.role !== "admin" && input.role !== "member") {
      throw invalidInput("Account role must be admin or member.");
    }
    const now = new Date().toISOString();
    if (input.email !== undefined) this.writeEmail(accountId, normalizeEmail(input.email), now);
    const role = input.role ?? current.role;
    const disabledAt = input.disabled === undefined
      ? current.disabledAt ?? null
      : input.disabled ? current.disabledAt ?? now : null;
    const credentialsChangedAt = input.password !== undefined || (input.disabled && !current.disabledAt)
      ? now
      : current.credentialsChangedAt;

    if ((role !== "admin" || disabledAt) && current.role === "admin" && !current.disabledAt) {
      this.assertNotLastActiveAdmin(accountId);
    }

    if (input.password !== undefined) {
      this.database.connection
        .prepare("UPDATE accounts SET password_scrypt = ? WHERE id = ?")
        .run(hashPassword(assertPassword(input.password)), accountId);
    }
    this.database.connection
      .prepare("UPDATE accounts SET role = ?, disabled_at = ?, credentials_changed_at = ?, updated_at = ? WHERE id = ?")
      .run(role, disabledAt, credentialsChangedAt, now, accountId);
    return this.getAccount(accountId);
  }

  deleteAccount(accountId: string): void {
    const account = this.getAccount(accountId);
    if (account.role === "admin" && !account.disabledAt) this.assertNotLastActiveAdmin(accountId);
    // Products the account created outlive it. Their created_by_account_id keeps
    // pointing at an id nothing resolves, which reads as "nobody owns this"
    // rather than as a dangling reference -- the alternative is deleting a
    // product, and its work items, because a person left.
    this.database.connection.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
  }

  /**
   * Change your own sign-in address.
   *
   * The current password is required for the same reason changing a password is:
   * the address is what you sign in with, so taking it over is taking over the
   * account, and a borrowed unlocked browser should not be enough.
   *
   * Credentials are deliberately left alone. The address is an identifier, not a
   * secret -- bumping the stamp would sign every other session out for what is,
   * to the owner, a correction.
   */
  changeOwnEmail(accountId: string, currentPassword: string, email: string): AccountSnapshot {
    const row = this.row(accountId);
    if (!row || row.disabled_at) throw notFound("Account");
    if (!verifyPassword(row.password_scrypt, currentPassword)) {
      throw new MissionGoError("invalid_credentials", "The current password is not correct.", 401);
    }
    this.writeEmail(accountId, normalizeEmail(email), new Date().toISOString());
    return this.getAccount(accountId);
  }

  /**
   * Change your own password. Holding the session cookie is not enough -- the
   * current password has to be typed, so a borrowed unlocked browser cannot lock
   * its owner out.
   *
   * Moving credentials_changed_at signs out every other session, including the
   * one that made this change; the caller reissues a cookie for itself.
   */
  changeOwnPassword(accountId: string, currentPassword: string, newPassword: string): AccountSnapshot {
    const row = this.row(accountId);
    if (!row || row.disabled_at) throw notFound("Account");
    if (!verifyPassword(row.password_scrypt, currentPassword)) {
      throw new MissionGoError("invalid_credentials", "The current password is not correct.", 401);
    }
    const password = assertPassword(newPassword);
    if (verifyPassword(row.password_scrypt, password)) {
      throw invalidInput("Choose a password different from the current one.");
    }
    const now = new Date().toISOString();
    this.database.connection
      .prepare("UPDATE accounts SET password_scrypt = ?, credentials_changed_at = ?, updated_at = ? WHERE id = ?")
      .run(hashPassword(password), now, now, accountId);
    return this.getAccount(accountId);
  }

  /** Verify a sign-in. Returns nothing for a wrong password, an unknown email, or a suspended account. */
  verifyCredentials(email: string, password: string): AccountSnapshot | undefined {
    const row = this.database.connection
      .prepare("SELECT * FROM accounts WHERE email = ? COLLATE NOCASE")
      .get(email.trim()) as unknown as AccountRow | undefined;
    if (!row || row.disabled_at) return undefined;
    if (!verifyPassword(row.password_scrypt, password)) return undefined;
    return mapAccount(row);
  }

  /**
   * Whether a signed session or AI token is still good for this account.
   *
   * The signature only proves the server minted it. Everything that should end a
   * session early -- the account was deleted, suspended, or its credentials
   * changed -- is recorded here, not in the token.
   *
   * `credentialsAt` is the stamp the token was signed under, and it has to match
   * exactly. "Issued after the change" would be wrong in both directions at
   * once: tokens carry whole seconds, so it would refuse the replacement cookie
   * minted in the same second as the password change, and admit a stale one from
   * that same second.
   */
  resolveActive(accountId: string, credentialsAt: number): AccountSnapshot | undefined {
    const row = this.row(accountId);
    if (!row || row.disabled_at) return undefined;
    if (Date.parse(row.credentials_changed_at) !== credentialsAt) return undefined;
    return mapAccount(row);
  }

  /** The stamp to sign into a token so `resolveActive` will accept it. */
  credentialsStamp(account: AccountSnapshot): number {
    return Date.parse(account.credentialsChangedAt);
  }

  /**
   * The account, if it still exists and is still enabled.
   *
   * For credentials that stand on their own rather than on a password -- a
   * machine's node token, which the console can revoke individually. Changing a
   * password must not silently unpair every Mac, so `credentials_changed_at` is
   * deliberately not consulted here.
   */
  findActive(accountId: string): AccountSnapshot | undefined {
    const row = this.row(accountId);
    return !row || row.disabled_at ? undefined : mapAccount(row);
  }

  listPermissions(accountId: string): readonly ProductPermission[] {
    const rows = this.database.connection
      .prepare("SELECT product_id, can_view, can_operate, can_use_ai FROM account_products WHERE account_id = ?")
      .all(accountId) as unknown as PermissionRow[];
    return rows.map((row) => ({
      productId: row.product_id,
      canView: row.can_view === 1,
      canOperate: row.can_operate === 1,
      canUseAi: row.can_use_ai === 1,
    }));
  }

  /**
   * The same relation read from the product's side: every account, and what it
   * holds on this one product.
   *
   * Administrators are included and marked, because a list of "who can reach
   * this product" that silently omits the people who reach everything is a list
   * that misleads.
   */
  listProductAccess(productId: string): readonly ProductAccessEntry[] {
    const accounts = this.listAccounts();
    const rows = this.database.connection
      .prepare("SELECT account_id, can_view, can_operate, can_use_ai FROM account_products WHERE product_id = ?")
      .all(productId) as unknown as Array<PermissionRow & { account_id: string }>;
    const byAccount = new Map(rows.map((row) => [row.account_id, row]));
    return accounts.map((account) => {
      const row = byAccount.get(account.id);
      return {
        account,
        permission: {
          productId,
          canView: row?.can_view === 1,
          canOperate: row?.can_operate === 1,
          canUseAi: row?.can_use_ai === 1,
        },
        reachesByRole: account.role === "admin",
      };
    });
  }

  /**
   * Set who reaches one product, from the product's side.
   *
   * Only this product's rows are touched: the caller is looking at one product
   * and cannot see what else an account holds, so replacing the whole set --
   * the way the account-side editor does -- would silently revoke permissions
   * that were never on screen.
   */
  replaceProductAccess(productId: string, entries: readonly { accountId: string; permission: Omit<ProductPermission, "productId"> }[]): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      for (const entry of entries) {
        this.getAccount(entry.accountId);
        const canOperate = entry.permission.canOperate;
        const canUseAi = entry.permission.canUseAi;
        const canView = entry.permission.canView || canOperate || canUseAi;
        if (!canView) {
          this.database.connection
            .prepare("DELETE FROM account_products WHERE account_id = ? AND product_id = ?")
            .run(entry.accountId, productId);
          continue;
        }
        this.database.connection
          .prepare(
            `INSERT INTO account_products
               (account_id, product_id, can_view, can_operate, can_use_ai, created_at, updated_at)
             VALUES (?, ?, 1, ?, ?, ?, ?)
             ON CONFLICT (account_id, product_id) DO UPDATE SET
               can_view = 1,
               can_operate = excluded.can_operate,
               can_use_ai = excluded.can_use_ai,
               updated_at = excluded.updated_at`,
          )
          .run(entry.accountId, productId, canOperate ? 1 : 0, canUseAi ? 1 : 0, now, now);
      }
    });
  }

  /** Replace an account's whole permission set. Rows not listed are removed. */
  replacePermissions(accountId: string, permissions: readonly ProductPermission[]): readonly ProductPermission[] {
    this.getAccount(accountId);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.connection.prepare("DELETE FROM account_products WHERE account_id = ?").run(accountId);
      for (const permission of permissions) {
        // Operating on a product you cannot see, or reading it through an AI
        // client you cannot read it yourself, are not states worth storing.
        const canOperate = permission.canOperate;
        const canUseAi = permission.canUseAi;
        const canView = permission.canView || canOperate || canUseAi;
        if (!canView) continue;
        this.database.connection
          .prepare(
            `INSERT INTO account_products
               (account_id, product_id, can_view, can_operate, can_use_ai, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(accountId, permission.productId, 1, canOperate ? 1 : 0, canUseAi ? 1 : 0, now, now);
      }
    });
    return this.listPermissions(accountId);
  }

  /**
   * Give the creator of a new product full reach over it.
   *
   * Without this a member creates a product and immediately cannot see it,
   * which looks exactly like the creation having failed.
   */
  grantCreatorPermissions(accountId: string, productId: string): void {
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `INSERT INTO account_products
           (account_id, product_id, can_view, can_operate, can_use_ai, created_at, updated_at)
         VALUES (?, ?, 1, 1, 1, ?, ?)
         ON CONFLICT (account_id, product_id)
         DO UPDATE SET can_view = 1, can_operate = 1, can_use_ai = 1, updated_at = excluded.updated_at`,
      )
      .run(accountId, productId, now, now);
  }

  /**
   * Whether this account reaches this product with this capability.
   *
   * An administrator reaches every product in the console: that is what the role
   * is for, and writing a permission row per administrator per product would
   * mean a new product is invisible to its own creator until someone remembers
   * to tick the boxes.
   *
   * AI reach is the exception, and deliberately so. `ADMIN_AUTHORIZED_PRODUCT_IDS`
   * let a deployment say "an AI client signed in as me may only read these
   * products", and the seed turns that setting into `can_use_ai` rows. If the
   * role short-circuited those too, upgrading would silently hand every AI
   * client the whole workspace. So: an administrator with no AI rows reaches
   * everything -- which is what an unset variable always meant -- and an
   * administrator with AI rows is bounded by them.
   */
  allows(account: AccountSnapshot, productId: string, capability: ProductCapability): boolean {
    if (account.role === "admin" && !(capability === "ai" && this.hasAiLimit(account.id))) return true;
    const row = this.database.connection
      .prepare("SELECT can_view, can_operate, can_use_ai FROM account_products WHERE account_id = ? AND product_id = ?")
      .get(account.id, productId) as unknown as PermissionRow | undefined;
    if (!row) return false;
    if (capability === "operate") return row.can_operate === 1;
    if (capability === "ai") return row.can_use_ai === 1;
    return row.can_view === 1 || row.can_operate === 1 || row.can_use_ai === 1;
  }

  /** The products this account reaches, or `"*"` for everything. See `allows`. */
  reachableProductIds(account: AccountSnapshot, capability: ProductCapability): "*" | readonly string[] {
    if (account.role === "admin" && !(capability === "ai" && this.hasAiLimit(account.id))) return "*";
    const column = capability === "operate" ? "can_operate" : capability === "ai" ? "can_use_ai" : "can_view";
    const rows = this.database.connection
      .prepare(`SELECT product_id FROM account_products WHERE account_id = ? AND ${column} = 1`)
      .all(account.id) as unknown as Array<{ product_id: string }>;
    return rows.map((row) => row.product_id);
  }

  /** Whether this account has said anything at all about which products its AI clients may read. */
  hasAiLimit(accountId: string): boolean {
    const row = this.database.connection
      .prepare("SELECT 1 AS present FROM account_products WHERE account_id = ? AND can_use_ai = 1 LIMIT 1")
      .get(accountId) as unknown as { present: number } | undefined;
    return row !== undefined;
  }

  /** Record an authorization as it is handed out, so it can later be listed and revoked. */
  recordAiAuthorization(input: {
    readonly tokenId: string;
    readonly accountId: string;
    readonly clientId: string;
    readonly scopes: readonly string[];
    readonly issuedAt: number;
    readonly expiresAt: number;
  }): void {
    this.database.connection
      .prepare(
        `INSERT OR REPLACE INTO ai_authorizations
           (id, account_id, client_id, scopes_json, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tokenId,
        input.accountId,
        input.clientId,
        JSON.stringify([...input.scopes]),
        new Date(input.issuedAt * 1_000).toISOString(),
        new Date(input.expiresAt * 1_000).toISOString(),
      );
  }

  /**
   * Whether this authorization has been cut off.
   *
   * Only a row that exists and carries a revocation refuses. A token with no row
   * predates the table and stays valid until it expires -- shipping revocation
   * must not itself revoke everything.
   */
  aiAuthorizationRevoked(tokenId: string): boolean {
    const row = this.database.connection
      .prepare("SELECT revoked_at FROM ai_authorizations WHERE id = ?")
      .get(tokenId) as unknown as { revoked_at: string | null } | undefined;
    return row?.revoked_at != null;
  }

  /**
   * Note that an authorization was used, at most once every few minutes.
   *
   * "Last used" is what tells a reader which of five connected clients is the
   * one they forgot about. Writing it on every MCP call would put a database
   * write in front of every read for a field nobody needs to the second.
   */
  touchAiAuthorization(tokenId: string, now = Date.now()): void {
    const stamp = new Date(now).toISOString();
    this.database.connection
      .prepare(
        `UPDATE ai_authorizations
         SET last_used_at = ?
         WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
      )
      .run(stamp, tokenId, new Date(now - AI_AUTHORIZATION_TOUCH_INTERVAL_MS).toISOString());
  }

  /** Live authorizations for one account, newest first. Expired and revoked ones are left out. */
  listAiAuthorizations(accountId: string, now = Date.now()): readonly AiAuthorizationSnapshot[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, client_id, scopes_json, issued_at, expires_at, last_used_at
         FROM ai_authorizations
         WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY issued_at DESC`,
      )
      .all(accountId, new Date(now).toISOString()) as unknown as AiAuthorizationRow[];
    return rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      scopes: JSON.parse(row.scopes_json) as string[],
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    }));
  }

  /** Cut one authorization off. The client has to be authorized again to come back. */
  revokeAiAuthorization(accountId: string, tokenId: string): void {
    const changes = this.database.connection
      .prepare("UPDATE ai_authorizations SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), tokenId, accountId);
    // Scoped to the account on purpose: revoking by id alone would let one
    // account cut off another's client, and answering "not found" keeps it from
    // learning whether the id exists.
    if (Number(changes.changes) === 0) throw notFound("Authorization");
  }

  private writeEmail(accountId: string, email: string, now: string): void {
    try {
      this.database.connection
        .prepare("UPDATE accounts SET email = ?, updated_at = ? WHERE id = ?")
        .run(email, now, accountId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw conflict("account_email_conflict", "That email address already has an account.");
      }
      throw error;
    }
  }

  private assertNotLastActiveAdmin(accountId: string): void {
    const remaining = this.database.connection
      .prepare("SELECT COUNT(*) AS total FROM accounts WHERE role = 'admin' AND disabled_at IS NULL AND id <> ?")
      .get(accountId) as unknown as { total: number };
    if (remaining.total === 0) {
      throw conflict("last_admin_required", "The last active administrator cannot be removed or demoted.");
    }
  }

  private row(accountId: string): AccountRow | undefined {
    return this.database.connection
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(accountId) as unknown as AccountRow | undefined;
  }
}

function mapAccount(row: AccountRow): AccountSnapshot {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    ...(row.disabled_at ? { disabledAt: row.disabled_at } : {}),
    credentialsChangedAt: row.credentials_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
