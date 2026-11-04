import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { api, type GrantableAccountSummary, type ProductAccessEntry } from "./api";
import { accountPickerState, nextEnabledIndex } from "./account-picker-state";
import { useI18n } from "./i18n";

/** How long typing settles before the search leaves for the server. */
const SEARCH_DELAY_MS = 180;

/**
 * Picks a person to grant one product's access to (AND-390).
 *
 * Opening the field lists the accounts that can be granted; typing narrows the
 * list by nickname or address. It replaces "type the whole address", which was
 * the only way to add someone while the roster was an administrator's to know.
 *
 * Accounts that already hold something on this product, and the ones queued for
 * the next save, stay in the list but cannot be chosen: a picker that silently
 * dropped them would say the person does not exist.
 */
export function AccountPicker({
  productId,
  entries,
  added,
  onAdd,
}: {
  productId: string;
  entries: readonly ProductAccessEntry[];
  /** Addresses already queued for the next save. */
  added: readonly string[];
  onAdd: (account: { email: string; nickname?: string }) => void;
}) {
  const { t } = useI18n();
  const listId = `account-picker-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(text.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const query = useQuery({
    queryKey: ["grantable-accounts", productId, search],
    queryFn: () => api.listGrantableAccounts(productId, search),
    enabled: open,
    // Keep the last list on screen while the next search is in flight; blanking
    // it on every keystroke makes the menu flicker under the pointer.
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const candidates = query.data?.accounts ?? [];
  const granted = new Set(entries.map((entry) => entry.account.id));
  const queued = new Set(added.map((address) => address.toLocaleLowerCase()));
  const stateOf = (account: GrantableAccountSummary) => accountPickerState(account, granted, queued);
  const selectable = (account: GrantableAccountSummary) => stateOf(account) === "selectable";

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  useEffect(() => setActive(-1), [search]);

  const move = (from: number, step: 1 | -1): number =>
    nextEnabledIndex(candidates.length, from, step, (index) => selectable(candidates[index]!));

  const pick = (account: GrantableAccountSummary) => {
    onAdd({ email: account.email, ...(account.nickname ? { nickname: account.nickname } : {}) });
    setText("");
    setSearch("");
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => move(current, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" && open && active >= 0 && candidates[active] && selectable(candidates[active]!)) {
      // Only a highlighted row takes Enter. Otherwise it submits the address
      // that was typed, which is how someone adds an account their list is too
      // old to show.
      event.preventDefault();
      pick(candidates[active]!);
    } else if (event.key === "Escape") {
      setOpen(false);
      setActive(-1);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const status = query.isError
    ? t("accountPickerError")
    : query.isPending && !query.data
      ? t("accountPickerLoading")
      : candidates.length === 0
        ? t("accountPickerNoMatches")
        : null;

  return (
    <form
      className="account-picker"
      onSubmit={(event) => {
        event.preventDefault();
        const address = text.trim();
        if (!address) return;
        onAdd({ email: address });
        setText("");
        setSearch("");
        setOpen(false);
        setActive(-1);
      }}
    >
      <div className="account-picker-field" ref={rootRef}>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          value={text}
          placeholder={t("accountPickerPlaceholder")}
          aria-label={t("accountPickerPlaceholder")}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {open && (
          <ul className="account-picker-list" id={listId} role="listbox" aria-label={t("accountPickerList")}>
            {status && <li className="account-picker-status" role="presentation">{status}</li>}
            {!status && candidates.map((account, index) => {
              const state = stateOf(account);
              return (
                <li
                  key={account.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  aria-disabled={state !== "selectable" || undefined}
                  className={`account-picker-option${index === active && state === "selectable" ? " active" : ""}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerMove={(event) => {
                    if (event.pointerType === "mouse" && state === "selectable") setActive(index);
                  }}
                  onClick={() => { if (state === "selectable") pick(account); }}
                >
                  <strong>{account.nickname || account.email}</strong>
                  {account.nickname && <small>{account.email}</small>}
                  {state !== "selectable" && (
                    <em>{state === "granted" ? t("accountAlreadyHasAccess") : t("accessPendingSave")}</em>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <button className="secondary-button" type="submit" disabled={!text.trim()}>
        <Plus size={15} /> {t("addByEmail")}
      </button>
    </form>
  );
}
