import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, KeyRound, LoaderCircle, AlertTriangle } from "lucide-react";
import { api, ApiError, type AuthSession } from "./api";
import { useI18n } from "./i18n";

export function LoginForm({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => api.login({ username: username.trim(), password }),
    onSuccess: onAuthenticated,
  });
  const loginError = mutation.error instanceof ApiError
    ? mutation.error.code === "invalid_credentials"
      ? t("invalidCredentials")
      : mutation.error.code === "login_rate_limited"
        ? t("loginRateLimited")
        : mutation.error.code === "authentication_unavailable"
          ? t("accountUnavailable")
          : mutation.error.message
    : mutation.isError
      ? t("somethingWentWrong")
      : null;
  return (
    <form className="login-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <label>{t("username")}<input type="email" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("usernamePlaceholder")} autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus /></label>
      <label>{t("password")}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("passwordPlaceholder")} autoComplete="current-password" required /></label>
      {loginError && <div className="inline-error" role="alert"><AlertTriangle size={16} /> {loginError}</div>}
      <p className="privacy-note"><KeyRound size={14} /> {t("noRegistration")}</p>
      <button className="primary-button wide" disabled={mutation.isPending || !username.trim() || !password}>
        {mutation.isPending ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />} {t("signIn")}
      </button>
    </form>
  );
}
