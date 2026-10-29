import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "./modal";
import { useI18n } from "./i18n";

type Options = { title?: string; confirmLabel?: string; danger?: boolean };
type Confirm = (message: string, options?: Options) => Promise<boolean>;
type Request = { message: string; options: Options; resolve: (value: boolean) => void };
const Confirmation = createContext<Confirm | null>(null);

export function useConfirm(): Confirm {
  const confirm = useContext(Confirmation);
  return confirm ?? (async message => window.confirm(message));
}

/** Async product confirmation, shared by destructive actions across screens. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const queue = useRef<Request[]>([]);
  const [request, setRequest] = useState<Request>();
  const confirm = useCallback<Confirm>((message, options = {}) => new Promise(resolve => {
    const next = { message, options, resolve };
    queue.current.push(next);
    setRequest(queue.current[0]);
  }), []);
  const finish = (value: boolean) => {
    queue.current.shift()?.resolve(value);
    setRequest(queue.current[0]);
  };
  useEffect(() => () => { for (const entry of queue.current.splice(0)) entry.resolve(false); }, []);
  return <Confirmation.Provider value={confirm}>
    {children}
    {request && <Modal title={request.options.title ?? t("confirmAction")} subtitle="" onClose={() => finish(false)}>
      <p className="confirmation-message">{request.message}</p>
      <div className="form-footer">
        <button type="button" className="secondary-button" data-initial-focus onClick={() => finish(false)}>{t("cancel")}</button>
        <button type="button" className={request.options.danger === false ? "primary-button" : "danger-button"} onClick={() => finish(true)}>{request.options.confirmLabel ?? t("confirm")}</button>
      </div>
    </Modal>}
  </Confirmation.Provider>;
}
