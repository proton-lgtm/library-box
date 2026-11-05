import { useState } from "react";
import { X } from "lucide-react";
import type { AuthCredentials, AuthState } from "../shared/types";

interface ProfileDialogProps {
  authState: AuthState;
  onClose: () => void;
  onSubmit: (mode: "signup" | "signin", credentials: AuthCredentials) => Promise<AuthState>;
  onSignOut: () => Promise<AuthState>;
}

export function ProfileDialog({ authState, onClose, onSubmit, onSignOut }: ProfileDialogProps) {
  const [mode, setMode] = useState<"signup" | "signin">(authState.status === "account" ? "signin" : "signup");
  const [email, setEmail] = useState(authState.email ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (mode === "signup" && password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const state = await onSubmit(mode, { email, password });
      if (state.status === "unavailable" && state.message) setError(state.message);
      else onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError("");
    try {
      const state = await onSignOut();
      if (state.status === "unavailable" && state.message) setError(state.message);
      else onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="dialog-card profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <button className="modal-close" onClick={onClose} aria-label="Close dialog"><X size={19} /></button>
        <h2 id="profile-title">Profile</h2>
        {authState.status === "account" ? (
          <>
            <p className="profile-email">{authState.email}</p>
            <button className="button-primary modal-submit" disabled={busy} onClick={() => void signOut()}>
              {busy ? "Signing out…" : "Sign out"}
            </button>
          </>
        ) : (
          <>
            <div className="auth-mode-tabs" role="tablist" aria-label="Account action">
              <button role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "selected" : ""} onClick={() => { setMode("signup"); setError(""); }}>Create account</button>
              <button role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "selected" : ""} onClick={() => { setMode("signin"); setError(""); }}>Sign in</button>
            </div>
            <label className="field-label" htmlFor="account-email">Email</label>
            <input id="account-email" className="auth-input" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <label className="field-label" htmlFor="account-password">Password</label>
            <input id="account-password" className="auth-input" type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} />
            {mode === "signup" && (
              <>
                <label className="field-label" htmlFor="account-password-confirm">Confirm password</label>
                <input id="account-password-confirm" className="auth-input" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
              </>
            )}
            {authState.message && <p className="profile-error">{authState.message}</p>}
            <button className="button-primary modal-submit" disabled={busy || !email.trim() || !password} onClick={() => void submit()}>
              {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </>
        )}
        {error && <p className="profile-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}
