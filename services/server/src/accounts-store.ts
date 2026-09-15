import { randomUUID } from "node:crypto";

import { conflict, invalidInput, MissionGoError, notFound } from "./errors.js";
import { hashPassword, verifyPassword, type AccountRole } from "./admin-auth.js";
import type { MissionGoDatabase } from "./storage/database.js";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1_024;

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
  updateAccount(accountId: string, input: { role?: AccountRole; disabled?: boolean; password?: string }): AccountSnapshot {
    const current = this.getAccount(accountId);
    if (input.role !== undefined && input.role !== "admin" && input.role !== "member") {
      throw invalidInput("Account role must be admin or member.");
    }
    const now = new Date().toISOString();
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
