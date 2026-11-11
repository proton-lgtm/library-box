"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

type TurnstileApi = {
  render: (container: HTMLElement, options: {
    sitekey: string;
    action: string;
    theme: string;
    size: string;
    callback: (token: string) => void;
    "expired-callback": () => void;
    "error-callback": () => void;
  }) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};

declare global {
  interface Window { turnstile?: TurnstileApi }
}

export function WaitlistForm({ siteKey, privacyUrl }: { siteKey: string; privacyUrl: string }) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const busy = useRef(false);
  const [scriptReady, setScriptReady] = useState(false);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const configured = Boolean(siteKey && privacyUrl);
  const challengeError = useCallback(() => {
    setToken("");
    setMessage("The security check could not load. Check your connection and try again.");
    setState("error");
  }, []);

  useEffect(() => {
    if (!scriptReady || !container.current || !window.turnstile || !configured) return;
    const api = window.turnstile;
    const id = api.render(container.current, {
      sitekey: siteKey,
      action: "waitlist",
      theme: "dark",
      size: "flexible",
      callback: (value) => setToken(value),
      "expired-callback": () => setToken(""),
      "error-callback": challengeError,
    });
    widget.current = id;
    return () => { api.remove(id); widget.current = null; };
  }, [scriptReady, configured, siteKey, challengeError]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !configured || state === "success") return;
    if (!token) {
      setState("error");
      setMessage("Complete the security check before joining.");
      return;
    }
    busy.current = true;
    const data = new FormData(event.currentTarget);
    setState("pending");
    setMessage("");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, consent, website: data.get("website") || "", turnstileToken: token }),
        signal: controller.signal,
      });
      if (!response.ok) {
        setState("error");
        setMessage(response.status === 400
          ? "Check your email and consent, then complete a new security check."
          : response.status === 429
            ? "Too many attempts. Please wait a moment and try again."
            : "We couldn’t save your signup right now. Your email is still here — please try again.");
        return;
      }
      setState("success");
      setMessage("You’re on the list. If this email is already registered, you’re all set.");
    } catch {
      setState("error");
      setMessage("We couldn’t connect. Your email hasn’t been cleared — check your connection and try again.");
    } finally {
      clearTimeout(timeout);
      busy.current = false;
      setToken("");
      if (widget.current !== null) window.turnstile?.reset(widget.current);
    }
  }

  return (
    <div className="waitlist" id="join">
      <form onSubmit={submit} aria-busy={state === "pending"}>
        <label className="sr-only" htmlFor="email">Email address</label>
        <div className="signup-row">
        <div className="email-field">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m3 7 9 6 9-6" /></svg>
          <input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={state === "pending" || state === "success"} aria-describedby="signup-message" />
        </div>
        <button className="submit-button" type="submit" disabled={!configured || !consent || !token || state === "pending" || state === "success"}>
          {state === "pending" ? "Joining…" : state === "success" ? "You’re on the list" : "Join the waitlist"}
          <span aria-hidden="true">{state === "success" ? "✓" : "→"}</span>
        </button>
        </div>
        <div className="honeypot" aria-hidden="true">
          <label htmlFor="website">Leave this field empty</label>
          <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
        </div>
        <label className="consent-row">
          <input name="consent" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required disabled={state === "pending" || state === "success"} />
          <span>I agree to receive Playmart launch and waitlist emails. {privacyUrl && <a href={privacyUrl} target="_blank" rel="noopener noreferrer">Privacy policy<span className="sr-only"> (opens in a new tab)</span></a>}</span>
        </label>
        {configured && (
          <>
            <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" strategy="afterInteractive" onReady={() => setScriptReady(true)} onError={challengeError} />
            <div className="challenge" ref={container} aria-label="Security verification" />
          </>
        )}
        {!configured && <p className="configuration-note">Signups are not open yet. The privacy policy and security check must be configured first.</p>}
        <p id="signup-message" className={`form-message ${state}`} role={state === "error" ? "alert" : "status"} aria-live="polite">{message}</p>
      </form>
      <p className="form-footnote">Just your email. No password. No account to create.</p>
    </div>
  );
}
