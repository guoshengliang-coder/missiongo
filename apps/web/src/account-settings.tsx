import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, Plus, Trash2, Unplug, UserRound } from "lucide-react";

import { MIN_PASSWORD_LENGTH } from "@missiongo/domain";

import {
  api,
  ApiError,
  type Account,
  type AccountRole,
  type AuthenticatedUser,
  type AiAuthorization,
  type ProductPermission,
} from "./api";
import { useI18n, type MessageKey } from "./i18n";
import type { Product } from "./types";

function messageFor(error: unknown, t: (key: MessageKey) => string, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === "account_email_conflict") return t("emailInUse");
    if (error.code === "last_admin_required") return t("lastAdminRequired");
    if (error.code === "invalid_credentials") return t("currentPasswordWrong");
    return error.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Change your own password.
 *
 * The current password is asked for even though the session is already open: a
 * cookie proves the browser was left signed in, not that the owner is at it.
 * Succeeding ends every other session, which is the point of the notice.
 */
function PasswordForm() {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirmation("");
      setDone(true);
    },
  });

  const mismatch = confirmation.length > 0 && next !== confirmation;
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
  const ready = current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && next === confirmation;

  return (
    <form
      className="account-password-form"
      onSubmit={(event) => {
        event.preventDefault();
        setDone(false);
        mutation.mutate();
      }}
    >
      <label>
        {t("currentPassword")}
        <input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <label>
        {t("newPassword")}
        <input
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
      </label>
      <label>
        {t("confirmNewPassword")}
        <input
          type="password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      {tooShort && <p className="account-note">{t("passwordTooShort", { count: MIN_PASSWORD_LENGTH })}</p>}
      {mismatch && <p className="account-note">{t("passwordsDoNotMatch")}</p>}
      {mutation.isError && <InlineNote danger message={messageFor(mutation.error, t, t("somethingWentWrong"))} />}
      {done && <InlineNote message={t("passwordChanged")} />}
      <button className="secondary-button" disabled={!ready || mutation.isPending}>
        {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("changePassword")}
      </button>
    </form>
  );
}

function InlineNote({ message, danger = false }: { message: string; danger?: boolean }) {
  return <p className={danger ? "account-note danger" : "account-note"}>{message}</p>;
}

/**
 * Change your own sign-in address.
 *
 * Gated on the current password for the same reason the password form is: the
 * address is what you sign in with, so taking it over is taking over the
 * account.
 */
function EmailForm({ user }: { user: AuthenticatedUser }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [email, setEmail] = useState(user.username);
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.changeEmail({ currentPassword: current, email: email.trim() }),
    onSuccess: () => {
      setCurrent("");
      setDone(true);
    },
  });

  const changed = email.trim().length > 0 && email.trim() !== user.username;

  return (
    <form
      className="account-password-form"
      onSubmit={(event) => {
        event.preventDefault();
        setDone(false);
        mutation.mutate();
      }}
    >
      <label>
        {t("newEmail")}
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </label>
      <label>
        {t("currentPassword")}
        <input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      {mutation.isError && <InlineNote danger message={messageFor(mutation.error, t, t("somethingWentWrong"))} />}
      {done && <InlineNote message={t("emailChanged")} />}
      <button className="secondary-button" disabled={!changed || current.length === 0 || mutation.isPending}>
        {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("changeEmail")}
      </button>
    </form>
  );
}

function AuthorizationRow({ authorization }: { authorization: AiAuthorization }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.revokeAiAuthorization(authorization.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai-authorizations"] }),
  });

  const when = (value: string) => new Date(value).toLocaleDateString(locale);
  const name = authorization.clientName ?? t("unknownAiClient");

  return (
    <article className="account-row">
      <header>
        <div className="ai-authorization-identity">
          <strong>{name}</strong>
          <small>
            {t("aiAuthorizedAt", { date: when(authorization.issuedAt) })}
            {" · "}
            {authorization.lastUsedAt ? t("aiLastUsed", { date: when(authorization.lastUsedAt) }) : t("aiNeverUsed")}
            {" · "}
            {t("aiExpires", { date: when(authorization.expiresAt) })}
          </small>
        </div>
        <button
          type="button"
          className="secondary-button archive-button"
          disabled={revoke.isPending}
          onClick={() => {
            if (window.confirm(t("confirmRevokeAi", { client: name }))) revoke.mutate();
          }}
        >
          {revoke.isPending ? <LoaderCircle className="spin" size={15} /> : <Unplug size={15} />} {t("revokeAi")}
        </button>
      </header>
      <p className="account-note">{authorization.scopes.join(" · ")}</p>
      {revoke.isError && <InlineNote danger message={messageFor(revoke.error, t, t("somethingWentWrong"))} />}
    </article>
  );
}

/** What is connected to your account, and the way to disconnect one of them. */
function ConnectedAiClients() {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ["ai-authorizations"], queryFn: api.listAiAuthorizations });

  return (
    <section className="account-authorizations">
      <h3>{t("connectedAi")}</h3>
      <p className="account-note">{t("connectedAiHelp")}</p>
      {query.isPending && <p className="account-note"><LoaderCircle className="spin" size={15} /></p>}
      {query.isError && <InlineNote danger message={messageFor(query.error, t, t("somethingWentWrong"))} />}
      {query.data && (query.data.authorizations.length === 0
        ? <InlineNote message={t("noConnectedAi")} />
        : (
          <div className="account-list">
            {query.data.authorizations.map((authorization) => (
              <AuthorizationRow key={authorization.id} authorization={authorization} />
            ))}
          </div>
        ))}
    </section>
  );
}

/**
 * One account's product reach, as a grid of three switches per product.
 *
 * Saved whole rather than per tick: the server replaces the set, so sending the
 * whole grid is the only shape in which an unticked row reliably means revoked.
 */
function PermissionGrid({ account, products }: { account: Account; products: readonly Product[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<readonly ProductPermission[]>(account.permissions);
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.setAccountProducts(account.id, draft.filter((entry) => entry.canView || entry.canOperate || entry.canUseAi)),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  const permissionFor = (productId: string): ProductPermission =>
    draft.find((entry) => entry.productId === productId)
    ?? { productId, canView: false, canOperate: false, canUseAi: false };

  const toggle = (productId: string, field: "canView" | "canOperate" | "canUseAi", checked: boolean) => {
    setSaved(false);
    const current = permissionFor(productId);
    const updated: ProductPermission = { ...current, [field]: checked };
    setDraft([...draft.filter((entry) => entry.productId !== productId), updated]);
  };

  if (products.length === 0) return <p className="account-note">{t("noProductsToGrant")}</p>;

  return (
    <div className="account-permissions">
      <p className="account-note">{account.role === "admin" ? t("adminProductsHelp") : t("accountProductsHelp")}</p>
      <table>
        <thead>
          <tr>
            <th>{t("accountProducts")}</th>
            <th>{t("permissionView")}</th>
            <th>{t("permissionOperate")}</th>
            <th>{t("permissionUseAi")}</th>
          </tr>
        </thead>
        <tbody>
          {products.map((product) => {
            const permission = permissionFor(product.id);
            return (
              <tr key={product.id}>
                <td>{product.name}</td>
                {(["canView", "canOperate", "canUseAi"] as const).map((field) => (
                  <td key={field}>
                    <input
                      type="checkbox"
                      // Operate and AI each include viewing, so a ticked one
                      // shows view as ticked rather than letting the grid say
                      // something the server will not store.
                      checked={field === "canView"
                        ? permission.canView || permission.canOperate || permission.canUseAi
                        : permission[field]}
                      disabled={field === "canView" && (permission.canOperate || permission.canUseAi)}
                      onChange={(event) => toggle(product.id, field, event.target.checked)}
                      aria-label={`${product.name} · ${t(field === "canView" ? "permissionView" : field === "canOperate" ? "permissionOperate" : "permissionUseAi")}`}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {mutation.isError && <InlineNote danger message={messageFor(mutation.error, t, t("somethingWentWrong"))} />}
      <div className="account-permissions-footer">
        {saved && <span className="account-note">{t("permissionsSaved")}</span>}
        <button className="secondary-button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("savePermissions")}
        </button>
      </div>
    </div>
  );
}

function AccountRow({ account, products, isSelf }: { account: Account; products: readonly Product[]; isSelf: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(account.email);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["accounts"] });
  const suspend = useMutation({
    mutationFn: (disabled: boolean) => api.updateAccount(account.id, { disabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: () => api.deleteAccount(account.id), onSuccess: invalidate });
  const rename = useMutation({
    mutationFn: () => api.updateAccount(account.id, { email: email.trim() }),
    onSuccess: invalidate,
  });

  const error = suspend.error ?? remove.error ?? rename.error;

  return (
    <article className={account.disabledAt ? "account-row suspended" : "account-row"}>
      <header>
        <button type="button" className="text-button" onClick={() => setOpen(!open)}>
          <strong>{account.email}</strong>
        </button>
        <em>{t(account.role === "admin" ? "administratorRole" : "memberRole")}</em>
        {account.disabledAt && <span className="status-pill status-cancelled">{t("suspendedAccount")}</span>}
        {!isSelf && (
          <>
            <button
              type="button"
              className="secondary-button"
              disabled={suspend.isPending}
              onClick={() => suspend.mutate(!account.disabledAt)}
            >
              {t(account.disabledAt ? "restoreAccount" : "suspendAccount")}
            </button>
            <button
              type="button"
              className="secondary-button archive-button"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t("confirmDeleteAccount", { email: account.email }))) remove.mutate();
              }}
            >
              <Trash2 size={15} /> {t("deleteAccount")}
            </button>
          </>
        )}
      </header>
      {error && <InlineNote danger message={messageFor(error, t, t("somethingWentWrong"))} />}
      {open && (
        <>
          {/* How an account seeded before addresses were required gets a real
              one: until this existed, nothing could change it. */}
          <div className="account-email-row">
            <label>
              {t("newAccountEmail")}
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={rename.isPending || !email.trim() || email.trim() === account.email}
              onClick={() => rename.mutate()}
            >
              {rename.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("savePermissions")}
            </button>
          </div>
          <PermissionGrid account={account} products={products} />
        </>
      )}
    </article>
  );
}

/**
 * Create an account. There is no public sign-up: an administrator sets a first
 * password and passes it on, and the owner replaces it from their own settings.
 */
function NewAccountForm() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AccountRole>("member");

  const mutation = useMutation({
    mutationFn: () => api.createAccount({ email: email.trim(), password, role }),
    onSuccess: async () => {
      setEmail("");
      setPassword("");
      setRole("member");
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  return (
    <form
      className="account-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <label>
        {t("newAccountEmail")}
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={t("usernamePlaceholder")}
          autoComplete="off"
          required
        />
      </label>
      <label>
        {t("newAccountPassword")}
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
        <small>{t("newAccountPasswordHelp", { count: MIN_PASSWORD_LENGTH })}</small>
      </label>
      <label>
        {t("accountRole")}
        <select value={role} onChange={(event) => setRole(event.target.value as AccountRole)}>
          <option value="member">{t("memberRole")}</option>
          <option value="admin">{t("administratorRole")}</option>
        </select>
      </label>
      {tooShort && <p className="account-note">{t("passwordTooShort", { count: MIN_PASSWORD_LENGTH })}</p>}
      {mutation.isError && <InlineNote danger message={messageFor(mutation.error, t, t("somethingWentWrong"))} />}
      <button className="primary-button" disabled={mutation.isPending || !email.trim() || password.length < MIN_PASSWORD_LENGTH}>
        {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t("addAccount")}
      </button>
    </form>
  );
}

/** The accounts on this deployment, and what each of them reaches. Administrators only. */
export function AccountManagement({ user, products }: { user: AuthenticatedUser; products: readonly Product[] }) {
  const { t } = useI18n();
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });

  if (accountsQuery.isPending) return <p className="account-note"><LoaderCircle className="spin" size={15} /></p>;
  if (accountsQuery.isError) {
    return <InlineNote danger message={messageFor(accountsQuery.error, t, t("somethingWentWrong"))} />;
  }

  return (
    <div className="account-management">
      <p className="account-note">{t("accountsHelp")}</p>
      <div className="account-list">
        {accountsQuery.data.accounts.map((account) => (
          <AccountRow key={account.id} account={account} products={products} isSelf={account.id === user.id} />
        ))}
      </div>
      <NewAccountForm />
    </div>
  );
}

/** Who you are signed in as, your password, and -- for an administrator -- everyone else. */
export function AccountSettings({
  user,
  products,
  onLoggedOut,
}: {
  user: AuthenticatedUser;
  products: readonly Product[];
  onLoggedOut: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"me" | "accounts">("me");
  const logout = useMutation({ mutationFn: api.logout, onSuccess: onLoggedOut });

  return (
    <div className="account-panel">
      {user.role === "admin" && (
        <div className="account-tabs" role="tablist">
          {(["me", "accounts"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? "text-button selected" : "text-button"}
              onClick={() => setTab(value)}
            >
              {t(value === "me" ? "myAccountTab" : "manageAccountsTab")}
            </button>
          ))}
        </div>
      )}

      {tab === "me" || user.role !== "admin" ? (
        <>
          <div className="account-identity">
            <span><UserRound size={21} /></span>
            <div>
              <small>{t("signedInAs")}</small>
              <strong>{user.username}</strong>
              <em>{t(user.role === "admin" ? "administratorRole" : "memberRole")}</em>
            </div>
          </div>
          <EmailForm user={user} />
          <PasswordForm />
          <ConnectedAiClients />
          {logout.isError && <InlineNote danger message={messageFor(logout.error, t, t("somethingWentWrong"))} />}
          <button className="secondary-button wide" disabled={logout.isPending} onClick={() => logout.mutate()}>
            {logout.isPending ? <LoaderCircle className="spin" size={16} /> : null} {t("signOut")}
          </button>
        </>
      ) : (
        <AccountManagement user={user} products={products} />
      )}
    </div>
  );
}

/**
 * Who can reach one product, edited from that product's settings (item 2.2).
 *
 * The same relation as the grid in the account panel, read the other way round.
 * Only this product's rows are sent, because from here you cannot see what else
 * an account holds -- replacing its whole set would revoke permissions that were
 * never on screen.
 */
export function ProductAccessSettings({ productId }: { productId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, ProductPermission> | null>(null);
  const [saved, setSaved] = useState(false);

  const query = useQuery({
    queryKey: ["product-accounts", productId],
    queryFn: () => api.listProductAccounts(productId),
  });

  const mutation = useMutation({
    mutationFn: () => api.setProductAccounts(
      productId,
      Object.entries(draft ?? {}).map(([accountId, permission]) => ({
        accountId,
        canView: permission.canView,
        canOperate: permission.canOperate,
        canUseAi: permission.canUseAi,
      })),
    ),
    onSuccess: async () => {
      setSaved(true);
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["product-accounts", productId] });
      // A permission change can add or remove a product from someone's list.
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  if (query.isPending) return <p className="account-note"><LoaderCircle className="spin" size={15} /></p>;
  if (query.isError) return <InlineNote danger message={messageFor(query.error, t, t("somethingWentWrong"))} />;

  const entries = query.data.accounts;
  const permissionFor = (accountId: string): ProductPermission =>
    draft?.[accountId] ?? entries.find((entry) => entry.account.id === accountId)!.permission;

  const toggle = (accountId: string, field: "canView" | "canOperate" | "canUseAi", checked: boolean) => {
    setSaved(false);
    const base = Object.fromEntries(entries.map((entry) => [entry.account.id, permissionFor(entry.account.id)]));
    setDraft({ ...base, [accountId]: { ...permissionFor(accountId), [field]: checked } });
  };

  return (
    <div className="account-permissions">
      <p className="account-note">{t("productAccessHelp")}</p>
      <table>
        <thead>
          <tr>
            <th>{t("newAccountEmail")}</th>
            <th>{t("permissionView")}</th>
            <th>{t("permissionOperate")}</th>
            <th>{t("permissionUseAi")}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const permission = permissionFor(entry.account.id);
            return (
              <tr key={entry.account.id}>
                <td>
                  {entry.account.email}
                  {/* An administrator reaches this product whatever the row
                      says, so a list that did not mark them would mislead. */}
                  {entry.reachesByRole && <em className="account-role-note"> · {t("reachesByRole")}</em>}
                </td>
                {(["canView", "canOperate", "canUseAi"] as const).map((field) => (
                  <td key={field}>
                    <input
                      type="checkbox"
                      checked={field === "canView"
                        ? permission.canView || permission.canOperate || permission.canUseAi
                        : permission[field]}
                      disabled={field === "canView" && (permission.canOperate || permission.canUseAi)}
                      onChange={(event) => toggle(entry.account.id, field, event.target.checked)}
                      aria-label={`${entry.account.email} · ${t(field === "canView" ? "permissionView" : field === "canOperate" ? "permissionOperate" : "permissionUseAi")}`}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {mutation.isError && <InlineNote danger message={messageFor(mutation.error, t, t("somethingWentWrong"))} />}
      <div className="account-permissions-footer">
        {saved && <span className="account-note">{t("productAccessSaved")}</span>}
        <button className="secondary-button" disabled={mutation.isPending || !draft} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("savePermissions")}
        </button>
      </div>
    </div>
  );
}
