import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, Pencil, Plus, Trash2, Unplug, UserRound, X } from "lucide-react";

import { MIN_PASSWORD_LENGTH } from "@missiongo/domain";

import {
  api,
  ApiError,
  type Account,
  type AccountRole,
  type AuthenticatedUser,
  type AiAuthorization,
  type ProductAccessEntry,
  type ProductPermission,
} from "./api";
import { closeAccountEditor, openAccountEditor, type AccountEditor } from "./account-edit-state";
import {
  draftDisplayName,
  MAX_ACCOUNT_NICKNAME_LENGTH,
  nicknameDraftChanged,
  parseNicknameDraft,
} from "./account-nickname";
import { useI18n, type MessageKey } from "./i18n";
import { permissionCell } from "./product-permissions";
import type { Product } from "./types";

function messageFor(error: unknown, t: (key: MessageKey) => string, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === "account_email_conflict") return t("emailInUse");
    if (error.code === "last_admin_required") return t("lastAdminRequired");
    if (error.code === "invalid_credentials") return t("currentPasswordWrong");
    if (error.code === "account_not_grantable") return t("accountNotGrantable");
    if (error.code === "own_access_unchangeable") return t("ownAccessUnchangeable");
    if (error.code === "admin_access_unchangeable") return t("adminAccessUnchangeable");
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
function PasswordForm({ onCancel }: { onCancel: () => void }) {
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
      <div className="account-form-actions">
        <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onCancel}>
          <X size={15} /> {t("cancel")}
        </button>
        <button className="secondary-button" disabled={!ready || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("changePassword")}
        </button>
      </div>
    </form>
  );
}

function InlineNote({ message, danger = false }: { message: string; danger?: boolean }) {
  return <p className={danger ? "account-note danger" : "account-note"}>{message}</p>;
}

/**
 * Choose what your comments are signed with.
 *
 * No password field, unlike the two forms below it. Those guard the account;
 * this is a label, and asking for a password to edit a label only teaches people
 * to type theirs wherever they are asked.
 */
function NicknameForm({ user, onCancel }: { user: AuthenticatedUser; onCancel: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // Seeded from the stored nickname, never from displayName: starting the field
  // with the fallback would let one Save turn it into a name the owner never
  // chose, and the address could then change without it following.
  const [draft, setDraft] = useState(user.nickname ?? "");
  const [done, setDone] = useState(false);

  const parsed = parseNicknameDraft(draft);
  const mutation = useMutation({
    mutationFn: () => api.changeNickname(parsed.ok ? parsed.nickname : null),
    onSuccess: async () => {
      setDone(true);
      // The signed-in-as line above reads from the bootstrap payload, so without
      // this the page keeps showing the old name back at you.
      await queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });

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
        {t("nickname")}
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={draftDisplayName("", user)}
          maxLength={MAX_ACCOUNT_NICKNAME_LENGTH * 2}
          autoComplete="nickname"
        />
      </label>
      <p className="account-note">{t("nicknameHelp")}</p>
      {!parsed.ok && <InlineNote danger message={t("nicknameTooLong", { max: MAX_ACCOUNT_NICKNAME_LENGTH })} />}
      {parsed.ok && <p className="account-note">{t("nicknamePreview", { name: draftDisplayName(draft, user) })}</p>}
      {mutation.isError && <InlineNote danger message={messageFor(mutation.error, t, t("somethingWentWrong"))} />}
      {done && <InlineNote message={t("nicknameChanged")} />}
      <div className="account-form-actions">
        <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onCancel}>
          <X size={15} /> {t("cancel")}
        </button>
        <button
          className="secondary-button"
          disabled={!parsed.ok || !nicknameDraftChanged(draft, user) || mutation.isPending}
        >
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("changeNickname")}
        </button>
      </div>
    </form>
  );
}

/**
 * Change your own sign-in address.
 *
 * Gated on the current password for the same reason the password form is: the
 * address is what you sign in with, so taking it over is taking over the
 * account.
 */
function EmailForm({ user, onCancel }: { user: AuthenticatedUser; onCancel: () => void }) {
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
      <div className="account-form-actions">
        <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onCancel}>
          <X size={15} /> {t("cancel")}
        </button>
        <button className="secondary-button" disabled={!changed || current.length === 0 || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("changeEmail")}
        </button>
      </div>
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

  // An administrator with no AI rows reaches every product by role (AND-63).
  const administrator = account.role === "admin"
    ? { aiUnrestricted: !draft.some((entry) => entry.canUseAi) }
    : undefined;

  const toggle = (productId: string, field: "canView" | "canOperate" | "canUseAi", checked: boolean) => {
    setSaved(false);
    if (administrator?.aiUnrestricted && field === "canUseAi" && !checked) {
      // Unticking one product while AI is unrestricted means "every product but
      // this one", and the only way the rows can say that is to name the rest.
      setDraft(products.map((product) => ({ ...permissionFor(product.id), canUseAi: product.id !== productId })));
      return;
    }
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
                {(["canView", "canOperate", "canUseAi"] as const).map((field) => {
                  // Operate and AI each include viewing, so a ticked one shows
                  // view as ticked rather than letting the grid say something
                  // the server will not store. An administrator's view and
                  // operate are the role's and stay locked; its AI stays
                  // editable here, because this grid is where it is narrowed.
                  const cell = permissionCell(field, permission, administrator);
                  return (
                    <td key={field}>
                      <input
                        type="checkbox"
                        checked={cell.checked}
                        disabled={(cell.byRole && field !== "canUseAi") || (!administrator && field === "canView" && (permission.canOperate || permission.canUseAi))}
                        title={cell.byRole && field !== "canUseAi" ? t("adminAccessByRole") : undefined}
                        onChange={(event) => toggle(product.id, field, event.target.checked)}
                        aria-label={`${product.name} · ${t(field === "canView" ? "permissionView" : field === "canOperate" ? "permissionOperate" : "permissionUseAi")}`}
                      />
                    </td>
                  );
                })}
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

function AccountRow({
  account,
  products,
  isSelf,
  editor,
  setEditor,
}: {
  account: Account;
  products: readonly Product[];
  isSelf: boolean;
  editor: AccountEditor | null;
  setEditor: (editor: AccountEditor | null) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState(account.email);
  const [nickname, setNickname] = useState(account.nickname ?? "");
  const editIntent = `account:${account.id}` as const;
  const open = editor === editIntent;

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
  const nicknameDraft = parseNicknameDraft(nickname);
  const renameNickname = useMutation({
    mutationFn: () => api.updateAccount(account.id, { nickname: nicknameDraft.ok ? nicknameDraft.nickname : null }),
    onSuccess: invalidate,
  });

  const error = suspend.error ?? remove.error ?? rename.error ?? renameNickname.error;

  return (
    <article className={account.disabledAt ? "account-row suspended" : "account-row"}>
      <header>
        <strong>{account.email}</strong>
        <em>{t(account.role === "admin" ? "administratorRole" : "memberRole")}</em>
        {account.disabledAt && <span className="status-pill status-cancelled">{t("suspendedAccount")}</span>}
        <button
          type="button"
          className="secondary-button"
          disabled={editor !== null}
          onClick={() => setEditor(openAccountEditor(editor, editIntent))}
        >
          <Pencil size={15} /> {t("editAccount")}
        </button>
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
          {/* Correcting a name somebody else chose. Unlike the address above it
              changes nothing they hold, so no session is disturbed. */}
          <div className="account-email-row">
            <label>
              {t("nickname")}
              <input
                type="text"
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder={account.email.split("@")[0] || account.email}
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={
                renameNickname.isPending
                || !nicknameDraft.ok
                || nicknameDraft.nickname === (account.nickname ?? null)
              }
              onClick={() => renameNickname.mutate()}
            >
              {renameNickname.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("savePermissions")}
            </button>
          </div>
          <PermissionGrid account={account} products={products} />
          <div className="account-form-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setEditor(closeAccountEditor(editor, editIntent))}
            >
              <X size={15} /> {t("cancel")}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

/**
 * Create an account. There is no public sign-up: an administrator sets a first
 * password and passes it on, and the owner replaces it from their own settings.
 */
function NewAccountForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
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
      onCreated();
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
      <div className="account-form-actions">
        <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onCancel}>
          <X size={15} /> {t("cancel")}
        </button>
        <button className="primary-button" disabled={mutation.isPending || !email.trim() || password.length < MIN_PASSWORD_LENGTH}>
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t("addAccount")}
        </button>
      </div>
    </form>
  );
}

/** The accounts on this deployment, and what each of them reaches. Administrators only. */
export function AccountManagement({ user, products }: { user: AuthenticatedUser; products: readonly Product[] }) {
  const { t } = useI18n();
  const [editor, setEditor] = useState<AccountEditor | null>(null);
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });

  if (accountsQuery.isPending) return <p className="account-note"><LoaderCircle className="spin" size={15} /></p>;
  if (accountsQuery.isError) {
    return <InlineNote danger message={messageFor(accountsQuery.error, t, t("somethingWentWrong"))} />;
  }

  return (
    <div className="account-management">
      <div className="account-management-header">
        <p className="account-note">{t("accountsHelp")}</p>
        <button
          type="button"
          className="primary-button"
          disabled={editor !== null}
          onClick={() => setEditor(openAccountEditor(editor, "new-account"))}
        >
          <Plus size={15} /> {t("addAccount")}
        </button>
      </div>
      {editor === "new-account" && (
        <NewAccountForm
          onCancel={() => setEditor(closeAccountEditor(editor, "new-account"))}
          onCreated={() => setEditor(closeAccountEditor(editor, "new-account"))}
        />
      )}
      <div className="account-list">
        {accountsQuery.data.accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            products={products}
            isSelf={account.id === user.id}
            editor={editor}
            setEditor={setEditor}
          />
        ))}
      </div>
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
  const [editor, setEditor] = useState<AccountEditor | null>(null);
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
              onClick={() => {
                setTab(value);
                setEditor(null);
              }}
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
              <strong>{user.displayName}</strong>
              <em>{user.username} · {t(user.role === "admin" ? "administratorRole" : "memberRole")}</em>
            </div>
          </div>
          <div className="account-edit-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={editor !== null}
              onClick={() => setEditor(openAccountEditor(editor, "nickname"))}
            >
              <Pencil size={15} /> {t("changeNickname")}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={editor !== null}
              onClick={() => setEditor(openAccountEditor(editor, "email"))}
            >
              <Pencil size={15} /> {t("changeEmail")}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={editor !== null}
              onClick={() => setEditor(openAccountEditor(editor, "password"))}
            >
              <Pencil size={15} /> {t("changePassword")}
            </button>
          </div>
          {editor === "nickname" && (
            <NicknameForm user={user} onCancel={() => setEditor(closeAccountEditor(editor, "nickname"))} />
          )}
          {editor === "email" && (
            <EmailForm user={user} onCancel={() => setEditor(closeAccountEditor(editor, "email"))} />
          )}
          {editor === "password" && (
            <PasswordForm onCancel={() => setEditor(closeAccountEditor(editor, "password"))} />
          )}
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
export function ProductAccessSettings(
  // `user` is undefined only while the session loads. The tab that mounts this is
  // already withheld until it resolves, so this is a type-level possibility
  // rather than a state worth drawing differently.
  { productId, user }: { productId: string; user: AuthenticatedUser | undefined },
) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, ProductPermission> | null>(null);
  const [added, setAdded] = useState<readonly string[]>([]);
  const [email, setEmail] = useState("");
  const [saved, setSaved] = useState(false);

  const query = useQuery({
    queryKey: ["product-accounts", productId],
    queryFn: () => api.listProductAccounts(productId),
  });

  // An administrator was handed the whole roster and edits it in place. A
  // creator was handed only who holds something, so it adds people by address
  // and leaves its own row and the administrators' alone -- matching the rows
  // the server will refuse to let it change.
  const editsRoster = user?.role === "admin";

  const mutation = useMutation({
    mutationFn: (accounts: Array<{ accountId?: string; email?: string } & Omit<ProductPermission, "productId">>) =>
      api.setProductAccounts(productId, accounts),
    onSuccess: async () => {
      setSaved(true);
      setDraft(null);
      setAdded([]);
      await queryClient.invalidateQueries({ queryKey: ["product-accounts", productId] });
      // A permission change can add or remove a product from someone's list.
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });

  if (query.isPending) return <p className="account-note"><LoaderCircle className="spin" size={15} /></p>;
  if (query.isError) return <InlineNote danger message={messageFor(query.error, t, t("somethingWentWrong"))} />;

  const entries = query.data.accounts;
  const permissionFor = (accountId: string): ProductPermission =>
    draft?.[accountId] ?? entries.find((entry) => entry.account.id === accountId)!.permission;

  /** A row this caller may edit. The server refuses the rest; this stops the offer. */
  const editable = (entry: ProductAccessEntry): boolean =>
    editsRoster || (entry.account.id !== user?.id && entry.account.role !== "admin");

  const toggle = (accountId: string, field: "canView" | "canOperate" | "canUseAi", checked: boolean) => {
    setSaved(false);
    const base = Object.fromEntries(entries.map((entry) => [entry.account.id, permissionFor(entry.account.id)]));
    setDraft({ ...base, [accountId]: { ...permissionFor(accountId), [field]: checked } });
  };

  const submit = () => {
    const rows = entries
      // Send only what this caller may change. An administrator sends the grid it
      // sees; a creator that also posted its own row and the administrators'
      // would have the whole save refused over rows it was never offered.
      .filter(editable)
      .map((entry) => ({ accountId: entry.account.id, ...permissionFor(entry.account.id) }));
    const newcomers = added.map((address) => ({ email: address, canView: true, canOperate: false, canUseAi: false }));
    mutation.mutate([...rows, ...newcomers]);
  };

  const addByEmail = () => {
    const address = email.trim();
    // The server decides whether the address has an account; this only keeps the
    // same one from being queued twice, which it would refuse as a duplicate.
    if (!address || added.some((existing) => existing.toLowerCase() === address.toLowerCase())) return;
    setSaved(false);
    setAdded([...added, address]);
    setEmail("");
  };

  const remove = (accountId: string) => {
    setSaved(false);
    const base = Object.fromEntries(entries.map((entry) => [entry.account.id, permissionFor(entry.account.id)]));
    // Clearing all three is how the one write path removes the row.
    setDraft({ ...base, [accountId]: { productId, canView: false, canOperate: false, canUseAi: false } });
  };

  const dirty = draft !== null || added.length > 0;

  return (
    <div className="account-permissions">
      <p className="account-note">{editsRoster ? t("productAccessHelp") : t("productAccessOwnerHelp")}</p>
      <table>
        <thead>
          <tr>
            <th>{t("newAccountEmail")}</th>
            <th>{t("permissionView")}</th>
            <th>{t("permissionOperate")}</th>
            <th>{t("permissionUseAi")}</th>
            {!editsRoster && <th />}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const permission = permissionFor(entry.account.id);
            const mayEdit = editable(entry);
            // An administrator whose stored row does not grant AI and who still
            // reaches it here has never been narrowed: AI is the role's, not a row's.
            const administrator = entry.reachesByRole
              ? { aiUnrestricted: entry.effective.canUseAi && !entry.permission.canUseAi }
              : undefined;
            const gone = permission.canView === false && permission.canOperate === false && permission.canUseAi === false;
            return (
              <tr key={entry.account.id}>
                <td>
                  {entry.account.email}
                  {/* An administrator reaches this product whatever the row
                      says, so a list that did not mark them would mislead. */}
                  {entry.reachesByRole && <em className="account-role-note"> · {t("reachesByRole")}</em>}
                  {/* Why the creator's own row is read-only: clearing it would
                      drop the product off their own list and take the settings
                      page with it. */}
                  {!editsRoster && entry.account.id === user?.id && (
                    <em className="account-role-note"> · {t("accessYoursToKeep")}</em>
                  )}
                </td>
                {(["canView", "canOperate", "canUseAi"] as const).map((field) => {
                  const cell = permissionCell(field, permission, administrator);
                  return (
                    <td key={field}>
                      <input
                        type="checkbox"
                        checked={cell.checked}
                        disabled={!mayEdit || cell.byRole || (!administrator && field === "canView" && (permission.canOperate || permission.canUseAi))}
                        title={cell.byRole ? t(field === "canUseAi" ? "adminAiByRole" : "adminAccessByRole") : undefined}
                        onChange={(event) => toggle(entry.account.id, field, event.target.checked)}
                        aria-label={`${entry.account.email} · ${t(field === "canView" ? "permissionView" : field === "canOperate" ? "permissionOperate" : "permissionUseAi")}`}
                      />
                    </td>
                  );
                })}
                {!editsRoster && (
                  <td>
                    {mayEdit && !gone && (
                      <button className="text-button" onClick={() => remove(entry.account.id)}>
                        {t("removeAccess")}
                      </button>
                    )}
                    {mayEdit && gone && <span className="account-note">{t("accessRemovedOnSave")}</span>}
                  </td>
                )}
              </tr>
            );
          })}
          {added.map((address) => (
            <tr key={`pending-${address}`}>
              <td>{address}<em className="account-role-note"> · {t("accessPendingSave")}</em></td>
              <td colSpan={4}>
                <button className="text-button" onClick={() => setAdded(added.filter((existing) => existing !== address))}>
                  {t("removeAccess")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!editsRoster && (
        <form
          className="account-email-row"
          onSubmit={(event) => {
            event.preventDefault();
            addByEmail();
          }}
        >
          {/* Typed rather than picked: a creator may add someone without being
              able to read who else has an account here. */}
          <input
            type="email"
            value={email}
            placeholder={t("addByEmailPlaceholder")}
            onChange={(event) => setEmail(event.target.value)}
            aria-label={t("addByEmail")}
          />
          <button className="secondary-button" type="submit" disabled={!email.trim()}>
            <Plus size={15} /> {t("addByEmail")}
          </button>
        </form>
      )}
      {mutation.isError && <InlineNote danger message={messageFor(mutation.error, t, t("somethingWentWrong"))} />}
      <div className="account-permissions-footer">
        {saved && <span className="account-note">{t("productAccessSaved")}</span>}
        <button className="secondary-button" disabled={mutation.isPending || !dirty} onClick={submit}>
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("savePermissions")}
        </button>
      </div>
    </div>
  );
}
