import { Select } from "./select";
import { useConfirm } from "./confirm-dialog";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, ClipboardCheck, LoaderCircle, Pencil, Plus, Trash2, Unplug, UserRound, X } from "lucide-react";

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
import { openAccountEditor, type AccountEditor } from "./account-edit-state";
import { groupAiConnections, type AiConnectionGroup } from "./ai-connections";
import {
  accountDisplayName,
  draftDisplayName,
  MAX_ACCOUNT_NICKNAME_LENGTH,
  nicknameDraftChanged,
  parseNicknameDraft,
} from "./account-nickname";
import { useI18n, type MessageKey } from "./i18n";
import { Modal } from "./modal";
import { useSettingsDraft } from "./settings-drafts";
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
function PasswordForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
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
      onSaved();
    },
  });

  useSettingsDraft(Boolean(current || next || confirmation), mutation.isPending);

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
        <button className="primary-button" disabled={!ready || mutation.isPending}>
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
function NicknameForm({ user, onCancel, onSaved }: { user: AuthenticatedUser; onCancel: () => void; onSaved: () => void }) {
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
      onSaved();
    },
  });

  useSettingsDraft(nicknameDraftChanged(draft, user) && !done, mutation.isPending);

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
          onChange={(event) => { setDraft(event.target.value); setDone(false); }}
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
          className="primary-button"
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
function EmailForm({ user, onCancel, onSaved }: { user: AuthenticatedUser; onCancel: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [email, setEmail] = useState(user.username);
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.changeEmail({ currentPassword: current, email: email.trim() }),
    onSuccess: async () => {
      setCurrent("");
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
      onSaved();
    },
  });

  useSettingsDraft((email !== user.username || Boolean(current)) && !done, mutation.isPending);

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
          onChange={(event) => { setEmail(event.target.value); setDone(false); }}
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
          onChange={(event) => { setCurrent(event.target.value); setDone(false); }}
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
        <button className="primary-button" disabled={!changed || current.length === 0 || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("changeEmail")}
        </button>
      </div>
    </form>
  );
}

function AiPermissions({ scopes }: { scopes: readonly string[] }) {
  const { t } = useI18n();
  const labels: Record<string, MessageKey> = {
    "missiongo:read": "aiScopeRead",
    "missiongo:write": "aiScopeWrite",
    "missiongo:node": "aiScopeNode",
  };
  return <>{scopes.map((scope) => labels[scope] ? t(labels[scope]) : scope).join(" · ")}</>;
}

function AuthorizationRow({ authorization, index, name }: { authorization: AiAuthorization; index: number; name: string }) {
  const confirm = useConfirm();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.revokeAiAuthorization(authorization.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai-authorizations"] }),
  });

  useSettingsDraft(false, revoke.isPending);

  const when = (value: string) => new Date(value).toLocaleDateString(locale);
  return (
    <article className="ai-connection-entry">
      <header>
        <strong>{t("aiConnectionNumber", { number: index + 1 })}</strong>
        <button
          type="button"
          className="secondary-button archive-button"
          disabled={revoke.isPending}
          onClick={async () => {
            const client = `${name} · ${t("aiConnectionNumber", { number: index + 1 })} · ${t("aiAuthorizedAt", { date: when(authorization.issuedAt) })}`;
            if (await confirm(t("confirmRevokeAi", { client }))) revoke.mutate();
          }}
        >
          {revoke.isPending ? <LoaderCircle className="spin" size={15} /> : <Unplug size={15} />} {t("revokeAi")}
        </button>
      </header>
      <dl className="ai-connection-facts">
        <div><dt>{t("aiPermissions")}</dt><dd><AiPermissions scopes={authorization.scopes} /></dd></div>
        <div><dt>{t("aiLastUsedLabel")}</dt><dd>{authorization.lastUsedAt ? when(authorization.lastUsedAt) : t("aiNeverUsed")}</dd></div>
        <div><dt>{t("aiAuthorizedLabel")}</dt><dd>{when(authorization.issuedAt)}</dd></div>
        <div><dt>{t("aiExpiresLabel")}</dt><dd>{when(authorization.expiresAt)}</dd></div>
      </dl>
      {revoke.isError && <InlineNote danger message={messageFor(revoke.error, t, t("somethingWentWrong"))} />}
    </article>
  );
}

function AiClientGroup({ group }: { group: AiConnectionGroup }) {
  const { t, locale } = useI18n();
  const name = group.name ?? t(group.kind === "pat" ? "personalTokenKind" : "unknownAiClient");
  return (
    <details className="ai-client-group">
      <summary className="ai-client-summary">
        <span className="ai-client-identity">
          <span className="ai-client-name"><strong>{name}</strong><small>{t("aiConnectionCount", { count: group.authorizations.length })}</small></span>
          <span className="ai-client-permissions">{group.scopes ? <AiPermissions scopes={group.scopes} /> : t("aiMixedPermissions")}</span>
        </span>
        <span className="ai-client-activity">{group.lastUsedAt
          ? t("aiLastUsed", { date: new Date(group.lastUsedAt).toLocaleDateString(locale) })
          : t("aiNeverUsed")}</span>
        <ChevronRight size={16} aria-hidden="true" />
      </summary>
      <div className="ai-client-connections">
        {group.authorizations.map((authorization, index) => (
          <AuthorizationRow key={authorization.id} authorization={authorization} index={index} name={name} />
        ))}
      </div>
    </details>
  );
}

/** What is connected to your account, and the way to disconnect one of them. */
function ConnectedAiClients() {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ["ai-authorizations"], queryFn: api.listAiAuthorizations });
  const groups = groupAiConnections(query.data?.authorizations ?? []);

  return (
    <section className="account-authorizations">
      <div className="ai-connections-heading">
        <h3>{t("connectedAi")}</h3>
        {groups.length > 0 && <span>{t("aiConnectionsTotal", { clients: groups.length, connections: query.data!.authorizations.length })}</span>}
      </div>
      <p className="account-note">{t("connectedAiHelp")}</p>
      {query.isPending && <p className="account-note"><LoaderCircle className="spin" size={15} /></p>}
      {query.isError && <InlineNote danger message={messageFor(query.error, t, t("somethingWentWrong"))} />}
      {query.data && (query.data.authorizations.length === 0
        ? <InlineNote message={t("noConnectedAi")} />
        : (
          <div className="ai-connections-categories">
            {(["oauth", "pat"] as const).map((kind) => {
              const category = groups.filter((group) => group.kind === kind);
              return category.length > 0 && (
                <section key={kind} className="ai-connections-category" aria-label={t(kind === "pat" ? "aiPersonalTokens" : "aiClientAuthorizations")}>
                  <h4>{t(kind === "pat" ? "aiPersonalTokens" : "aiClientAuthorizations")}</h4>
                  {category.map((group) => <AiClientGroup key={group.key} group={group} />)}
                </section>
              );
            })}
          </div>
        ))}
    </section>
  );
}

export function AiConnectionsSettings() {
  return <><PersonalTokenForm /><ConnectedAiClients /></>;
}

/**
 * Mint a personal access token (AND-288): the browserless-machine half of the
 * account settings. The name, scope and lifetime are asked for in a dialog that
 * exists only while minting; the token appears once, here, in a copyable field,
 * and afterwards only the named row in the connections list below remains.
 */
function PersonalTokenForm() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [write, setWrite] = useState(true);
  const [days, setDays] = useState(365);
  const [copied, setCopied] = useState(false);
  const tokenRef = useRef<HTMLTextAreaElement>(null);
  const create = useMutation({
    mutationFn: () => api.createPersonalToken({
      name,
      scopes: write ? ["missiongo:read", "missiongo:write"] : ["missiongo:read"],
      days,
    }),
    onSuccess: async () => {
      setName("");
      setCopied(false);
      await queryClient.invalidateQueries({ queryKey: ["ai-authorizations"] });
    },
  });
  const minted = create.data;
  const closeForm = () => {
    if (create.isPending) return;
    setCreating(false);
    setName("");
    create.reset();
  };
  const copyToken = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
    } catch {
      // No clipboard outside a secure context (a LAN address over http, some
      // WebViews). Select the token instead so a long-press or ⌘C still works.
      tokenRef.current?.select();
    }
  };

  return (
    <section className="account-authorizations" aria-labelledby="personal-token-title">
      <h3 id="personal-token-title">{t("personalTokens")}</h3>
      <p className="account-note">{t("personalTokensHelp")}</p>
      {!creating && <button type="button" className="primary-button" onClick={() => { create.reset(); setCreating(true); }}>{t("newPersonalToken")}</button>}
      {creating && (
        <Modal title={t(minted ? "personalTokenCreated" : "newPersonalToken")} subtitle={t("personalTokens")} onClose={closeForm} closeWarning={minted ? t("closeTokenWarning") : undefined} dirty={!minted && Boolean(name || !write || days !== 365)} pending={create.isPending}>
          {!minted && <>
          <form
            className="personal-token-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && !create.isPending) create.mutate();
            }}
          >
            <label>
              {t("personalTokenName")}
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("personalTokenNamePlaceholder")}
                maxLength={80}
                data-initial-focus
              />
            </label>
            <label>
              {t("personalTokenScopes")}
              <Select value={write ? "write" : "read"} onChange={(event) => setWrite(event.target.value === "write")}>
                <option value="read">{t("personalTokenScopeRead")}</option>
                <option value="write">{t("personalTokenScopeWrite")}</option>
              </Select>
            </label>
            <label>
              {t("personalTokenLifetime")}
              <Select value={days} onChange={(event) => setDays(Number(event.target.value))}>
                {[7, 30, 90, 365].map((choice) => (
                  <option key={choice} value={choice}>{t("personalTokenDays", { days: String(choice) })}</option>
                ))}
              </Select>
            </label>
            {create.isError && <InlineNote danger message={messageFor(create.error, t, t("somethingWentWrong"))} />}
            <div className="personal-token-actions">
              <button type="button" className="secondary-button" disabled={create.isPending} onClick={closeForm}>{t("cancel")}</button>
              <button type="submit" className="primary-button" disabled={!name.trim() || create.isPending}>
                {create.isPending ? <LoaderCircle className="spin" size={15} /> : null} {t("personalTokenCreate")}
              </button>
            </div>
          </form>
          </>}
      {minted && (
        <div className="account-add-form">
          <p><strong>{t("personalTokenCreated")}</strong> — {t("personalTokenCreatedHelp")}</p>
          <label htmlFor="personal-token-value">{t("personalTokens")}</label>
          <div className="personal-token-reveal">
            <textarea
              id="personal-token-value"
              ref={tokenRef}
              readOnly
              rows={2}
              value={minted.token}
              autoComplete="off"
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="secondary-button" onClick={() => void copyToken()}>
              {copied ? <Check size={15} /> : <ClipboardCheck size={15} />} {copied ? t("copied") : t("copyToken")}
            </button>
          </div>
        </div>
      )}
      {minted && <div className="form-footer"><button type="button" className="primary-button" onClick={closeForm}>{t("tokenCopiedDone")}</button></div>}
        </Modal>
      )}
    </section>
  );
}

/**
 * One account's product reach, as a grid of three switches per product.
 *
 * Saved whole rather than per tick: the server replaces the set, so sending the
 * whole grid is the only shape in which an unticked row reliably means revoked.
 */
function PermissionGrid({ account, products, productId, onCancel, onSaved }: { account: Account; products: readonly Product[]; productId?: string | undefined; onCancel: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<readonly ProductPermission[]>(account.permissions);
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.setAccountProducts(account.id, draft.filter((entry) => entry.canView || entry.canOperate || entry.canUseAi)),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      onSaved();
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

  useSettingsDraft(!saved && JSON.stringify(draft) !== JSON.stringify(account.permissions), mutation.isPending);

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
          {products.filter(product => !productId || product.id === productId).map((product) => {
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
        <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onCancel}>{t("cancel")}</button>
        <button className="primary-button" disabled={mutation.isPending || JSON.stringify(draft) === JSON.stringify(account.permissions)} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("savePermissions")}
        </button>
      </div>
    </div>
  );
}

function AccountRow({
  account,
  products,
  filterProductId,
  isSelf,
  editor,
  setEditor,
}: {
  account: Account;
  products: readonly Product[];
  filterProductId?: string | undefined;
  isSelf: boolean;
  editor: AccountEditor | null;
  setEditor: (editor: AccountEditor | null) => void;
}) {
  const confirm = useConfirm();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState(account.email);
  const [nickname, setNickname] = useState(account.nickname ?? "");
  const [permissionsOnly, setPermissionsOnly] = useState(Boolean(filterProductId));
  const permission = account.permissions.find(row => row.productId === filterProductId) ?? { canView: false, canOperate: false, canUseAi: false };
  const projectAdministrator = Boolean(filterProductId && account.projectAdministratorProductIds?.includes(filterProductId));
  const administrator = account.role === "admin" ? { aiUnrestricted: !account.permissions.some(row => row.canUseAi) } : undefined;
  const editIntent = `account:${account.id}` as const;
  const open = editor === editIntent;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["accounts"] });
  const suspend = useMutation({
    mutationFn: (disabled: boolean) => api.updateAccount(account.id, { disabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: () => api.deleteAccount(account.id), onSuccess: invalidate });
  const rename = useMutation({
    mutationFn: () => api.updateAccount(account.id, { email: email.trim(), nickname: parseNicknameDraft(nickname).ok ? nickname.trim() || null : account.nickname ?? null }),
    onSuccess: async () => { await invalidate(); setEditor(null); },
  });
  const nicknameDraft = parseNicknameDraft(nickname);


  useEffect(() => setEmail(account.email), [account.email, open]);
  useEffect(() => setNickname(account.nickname ?? ""), [account.nickname, open]);
  useSettingsDraft(false, suspend.isPending || remove.isPending);

  const error = suspend.error ?? remove.error ?? rename.error;

  return (
    <article className={account.disabledAt ? "account-row suspended" : "account-row"}>
      <header className="account-access-row">
        <div className="account-access-identity"><strong>{accountDisplayName(account)}</strong><small>{account.email}</small></div>
        {filterProductId && <dl className="account-access-permissions">
          {(["canView", "canOperate", "canUseAi"] as const).map(field => {
            const cell = permissionCell(field, permission, administrator);
            const label = t(field === "canView" ? "permissionView" : field === "canOperate" ? "permissionOperate" : "permissionUseAi");
            const effective = (cell.checked || field === "canView" && projectAdministrator) && !account.disabledAt;
            return <div key={field}><dt>{label}</dt><dd title={account.disabledAt ? "账号已停用，配置权限不生效" : cell.byRole ? t("adminAccessByRole") : undefined}>{effective ? "✓" : "—"}<span className="sr-only">{effective ? "已授权" : "未授权"}</span></dd></div>;
          })}
        </dl>}
        <div className="account-access-badges">
          <span className={account.role === "admin" ? "account-role is-admin" : "account-role"}>{t(projectAdministrator ? "settingsProjectAdministrators" : account.role === "admin" ? "administratorRole" : "memberRole")}</span>
          <span className="account-access-status">{account.disabledAt ? t("suspendedAccount") : "正常"}</span>
        </div>
        <div className="account-access-actions">
          <button type="button" className="secondary-button" disabled={editor !== null} onClick={() => { setPermissionsOnly(Boolean(filterProductId)); setEditor(openAccountEditor(editor, editIntent)); }}>
            <Pencil size={15} /> {filterProductId ? "修改权限" : t("editAccount")}
          </button>
          {!filterProductId && <button type="button" className="secondary-button" disabled={editor !== null} onClick={() => { setPermissionsOnly(true); setEditor(openAccountEditor(editor, editIntent)); }}>修改权限</button>}
          <details className="account-more"><summary className="secondary-button">更多</summary><div className="account-more-actions">
            {filterProductId && <button type="button" className="secondary-button" disabled={editor !== null} onClick={() => { setPermissionsOnly(false); setEditor(openAccountEditor(editor, editIntent)); }}>{t("editAccount")}</button>}
            <small>以下账号操作影响整个工作空间</small>
            {!isSelf && <>
              <button type="button" className="secondary-button" disabled={suspend.isPending} onClick={async () => {
                if (await confirm(`${account.disabledAt ? "恢复" : "停用"}账号 ${account.email}？此操作影响整个工作空间。`)) suspend.mutate(!account.disabledAt);
              }}>{t(account.disabledAt ? "restoreAccount" : "suspendAccount")}</button>
              <button type="button" className="secondary-button archive-button" disabled={remove.isPending} onClick={async () => {
                if (await confirm(`${t("confirmDeleteAccount", { email: account.email })} 此操作影响整个工作空间。`)) remove.mutate();
              }}><Trash2 size={15} /> {t("deleteAccount")}</button>
            </>}
            {isSelf && <small>当前登录账号不能在此停用或删除。</small>}
          </div></details>
        </div>
      </header>
      {error && <InlineNote danger message={messageFor(error, t, t("somethingWentWrong"))} />}
      {open && <Modal title={permissionsOnly ? "修改权限" : t("editAccount")} subtitle={accountDisplayName(account)} onClose={() => setEditor(null)}
        dirty={!permissionsOnly && (email !== account.email || nickname !== (account.nickname ?? ""))} pending={rename.isPending} wide={permissionsOnly} scrolls>
        {permissionsOnly ? <PermissionGrid account={account} products={products} productId={filterProductId} onCancel={() => setEditor(null)} onSaved={() => setEditor(null)} />
          : <form className="dialog-form" onSubmit={event => { event.preventDefault(); if (nicknameDraft.ok && !rename.isPending) rename.mutate(); }}>
            <label>{t("newAccountEmail")}<input type="email" required value={email} onChange={event => setEmail(event.target.value)} autoComplete="off" /></label>
            <label>{t("nickname")}<input value={nickname} onChange={event => setNickname(event.target.value)} maxLength={MAX_ACCOUNT_NICKNAME_LENGTH} autoComplete="off" /></label>
            {rename.isError && <InlineNote danger message={messageFor(rename.error, t, t("somethingWentWrong"))} />}
            <div className="form-footer">
              <button type="button" className="secondary-button" disabled={rename.isPending} onClick={() => setEditor(null)}>{t("cancel")}</button>
              <button type="submit" className="primary-button" disabled={rename.isPending || !nicknameDraft.ok || !email.trim() || email === account.email && nickname === (account.nickname ?? "")}>{t("save")}</button>
            </div>
          </form>}
      </Modal>}
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

  useSettingsDraft(Boolean(email || password), mutation.isPending);

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
        <Select value={role} onChange={(event) => setRole(event.target.value as AccountRole)}>
          <option value="member">{t("memberRole")}</option>
          <option value="admin">{t("administratorRole")}</option>
        </Select>
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
export function AccountManagement({ user, products, accountId, filterProductId, onNavigate }: {
  user: AuthenticatedUser; products: readonly Product[]; accountId?: string | undefined; filterProductId?: string | undefined;
  onNavigate?: (accountId?: string | undefined, filterProductId?: string | undefined) => void;
}) {
  const { t } = useI18n();
  const [localEditor, setLocalEditor] = useState<AccountEditor | null>(null);
  const [search, setSearch] = useState("");
  const [localFilter, setLocalFilter] = useState("");
  const filter = onNavigate ? filterProductId ?? "" : localFilter;
  const editor: AccountEditor | null = accountId ? `account:${accountId}` : localEditor;
  const setEditor = (next: AccountEditor | null) => {
    if (onNavigate && accountId) {
      onNavigate(next?.startsWith("account:") ? next.slice(8) : undefined, filter || undefined);
    } else setLocalEditor(next);
  };
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  if (accountsQuery.isPending) return <p className="account-note"><LoaderCircle className="spin" size={15} /></p>;
  if (accountsQuery.isError) return <InlineNote danger message={messageFor(accountsQuery.error, t, t("somethingWentWrong"))} />;
  const accounts = accountsQuery.data.accounts.filter(account => accountId ? account.id === accountId
    : (account.email.toLowerCase().includes(search.trim().toLowerCase()) || (account.nickname ?? "").toLowerCase().includes(search.trim().toLowerCase()))
      && (!filter || account.role === "admin" || account.projectAdministratorProductIds?.includes(filter) || account.permissions.some(permission => permission.productId === filter && (permission.canView || permission.canOperate || permission.canUseAi))));
  return <div className="account-management">
    {!accountId && <>
      <div className="settings-list-toolbar">
        <label className="settings-toolbar-search"><span className="sr-only">{t("settingsSearchAccounts")}</span><input type="search" placeholder={t("settingsSearchAccounts")} value={search} disabled={editor !== null} onChange={event => setSearch(event.target.value)} /></label>
        <label><span className="sr-only">{t("settingsFilterProduct")}</span><Select value={filter} disabled={editor !== null} onChange={event => onNavigate ? onNavigate(undefined, event.target.value || undefined) : setLocalFilter(event.target.value)}><option value="">{t("settingsAllProducts")}</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</Select></label>
        <button type="button" className="primary-button" disabled={editor !== null} onClick={() => setEditor(openAccountEditor(editor, "new-account"))}><Plus size={15} />{t("addAccount")}</button>
        {(search || filter) && <button type="button" className="text-button" onClick={() => { setSearch(""); if (onNavigate) onNavigate(undefined); else setLocalFilter(""); }}>{t("clearListFilters")}</button>}
      </div>
    </>}
    {editor === "new-account" && <Modal title={t("addAccount")} subtitle={t("settingsAccountsPermissions")} onClose={() => setEditor(null)}><p className="account-note">{t("accountsHelp")}</p><NewAccountForm onCancel={() => setEditor(null)} onCreated={() => setEditor(null)} /></Modal>}
    <div className="account-list account-access-list">
      {accounts.length === 0 && <p role="status" className="account-note">{t(accountId ? "settingsUnavailable" : "settingsNoMatchingAccounts")}</p>}
      {accounts.map(account => <AccountRow key={account.id} account={account} products={products} filterProductId={filter || undefined} isSelf={account.id === user.id} editor={editor} setEditor={setEditor} />)}
    </div>
  </div>;
}

export function DeepSeekSettings() {
  const confirm = useConfirm();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  const query = useQuery({ queryKey: ["ai-title-settings"], queryFn: api.getAiTitleSettings });
  const mutation = useMutation({
    mutationFn: (value: string | null) => api.setAiTitleKey(value),
    onSuccess: async () => {
      setEditing(false);
      setKey("");
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["ai-title-settings"] });
    },
    onError: () => setSaved(false),
  });
  const attentionMutation = useMutation({
    mutationFn: api.setAgentAttentionEnabled,
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["ai-title-settings"] });
    },
    onError: () => setSaved(false),
  });
  useSettingsDraft(false, !editing && mutation.isPending || attentionMutation.isPending);

  return (
    <section className="account-ai-settings">
      <h3>{t("deepseekSettings")}</h3>
      {query.isPending ? <p role="status">{t("settingsLoading")}</p> : query.isError ? <div role="alert"><InlineNote danger message={t("settingsLoadFailed")} /><button type="button" className="secondary-button" onClick={() => void query.refetch()}>{t("retry")}</button></div> : <>
        <strong className="model-configuration-status">{query.data.configured ? t("deepseekConfigured") : t("deepseekNotConfigured")}</strong>
        {query.data.configured && <p>{t("dispatchModel")}: {query.data.model}</p>}
      </>}
      <button type="button" className="secondary-button" disabled={!query.isSuccess} onClick={() => { setKey(""); mutation.reset(); setEditing(true); }}>{t("editConfiguration")}</button>
      {editing && <Modal title={t("deepseekSettings")} subtitle={t("settingsModelsTitle")} onClose={() => { setKey(""); setEditing(false); }} dirty={Boolean(key)} pending={mutation.isPending}>
        <p className="account-note">{t("deepseekSettingsHelp")}</p><form className="dialog-form" onSubmit={event => { event.preventDefault(); if (key.trim() && !mutation.isPending) mutation.mutate(key); }}>
          <label>{t("settingsApiKey")}<input type="password" required value={key} onChange={event => setKey(event.target.value)} placeholder={t("deepseekKeyPlaceholder")} autoComplete="off" spellCheck={false} /></label>
          {mutation.isError && <InlineNote danger message={messageFor(mutation.error, t, t("somethingWentWrong"))} />}
          <div className="form-footer"><button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => { setKey(""); setEditing(false); }}>{t("cancel")}</button><button type="submit" className="primary-button" disabled={!key.trim() || mutation.isPending}>{t("save")}</button></div>
        </form>
      {query.data?.configured && <button type="button" className="text-button" disabled={mutation.isPending}
        onClick={async () => { if (await confirm(t("confirmClearModelKey"), { confirmLabel: t("deepseekClearKey") })) mutation.mutate(null); }}>{t("deepseekClearKey")}</button>}
      </Modal>}
      <label className="account-ai-toggle">
        <input
          type="checkbox"
          checked={query.data?.agentAttentionEnabled ?? false}
          disabled={!query.data?.configured || mutation.isPending || attentionMutation.isPending}
          onChange={(event) => attentionMutation.mutate(event.target.checked)}
        />
        <span>
          <strong>{t("agentAttentionSetting")}</strong>
          <small>{t("agentAttentionSettingHelp")}</small>
        </span>
      </label>
      {saved && <p className="account-note">{t("permissionsSaved")}</p>}
      {(mutation.isError || attentionMutation.isError) && (
        <InlineNote danger message={messageFor(mutation.error ?? attentionMutation.error, t, t("somethingWentWrong"))} />
      )}
    </section>
  );
}

/** Who you are signed in as, your password, and -- for an administrator -- everyone else. */
export function AccountSettings({
  user,
  onLoggedOut,
}: {
  user: AuthenticatedUser;
  products: readonly Product[];
  onLoggedOut: () => void;
}) {
  const { t } = useI18n();
  const [editor, setEditor] = useState<AccountEditor | null>(null);
  const [notice, setNotice] = useState("");
  const saved = (message: string) => { setEditor(null); setNotice(message); };
  const logout = useMutation({ mutationFn: api.logout, onSuccess: onLoggedOut });

  return (
    <div className="account-panel">
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
              <Pencil size={15} /> {t("editNickname")}
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
            <Modal title={t("editNickname")} subtitle={t("settingsProfile")} onClose={() => setEditor(null)}><NicknameForm user={user} onCancel={() => setEditor(null)} onSaved={() => saved(t("nicknameChanged"))} /></Modal>
          )}
          {editor === "email" && (
            <Modal title={t("changeEmail")} subtitle={t("settingsProfile")} onClose={() => setEditor(null)}><EmailForm user={user} onCancel={() => setEditor(null)} onSaved={() => saved(t("emailChanged"))} /></Modal>
          )}
          {editor === "password" && (
            <Modal title={t("changePassword")} subtitle={t("settingsProfile")} onClose={() => setEditor(null)}><PasswordForm onCancel={() => setEditor(null)} onSaved={() => saved(t("passwordChanged"))} /></Modal>
          )}
          {notice && <p role="status" className="account-note">{notice}</p>}
          {logout.isError && <InlineNote danger message={messageFor(logout.error, t, t("somethingWentWrong"))} />}
          <div className="account-signout"><button className="secondary-button" disabled={logout.isPending || editor !== null} onClick={() => logout.mutate()}>
            {logout.isPending ? <LoaderCircle className="spin" size={16} /> : null} {t("signOut")}
          </button></div>
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

  useSettingsDraft(draft !== null || added.length > 0 || Boolean(email), mutation.isPending);

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
        <button type="button" className="secondary-button" disabled={mutation.isPending || !dirty && !email} onClick={() => { setDraft(null); setAdded([]); setEmail(""); setSaved(false); mutation.reset(); }}>{t("cancel")}</button>
        <button className="primary-button" disabled={mutation.isPending || !dirty} onClick={submit}>
          {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} {t("savePermissions")}
        </button>
      </div>
    </div>
  );
}
