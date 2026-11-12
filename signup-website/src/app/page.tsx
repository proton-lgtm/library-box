import Link from "next/link";
import { DesktopDemo } from "@/components/desktop-demo";
import { WaitlistForm } from "@/components/waitlist-form";

export const dynamic = "force-dynamic";

function privacyPolicyUrl(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

export default function Home() {
  const privacyUrl = privacyPolicyUrl(process.env.PRIVACY_POLICY_URL);
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <Link href="/" className="wordmark" aria-label="Playmart home"><span className="brand-symbol" aria-hidden="true"><i /><i /><i /></span>playmart<span className="wordmark-dot">.</span></Link>
        <a className="header-link" href="#demo">Try the preview <span aria-hidden="true">↗</span></a>
      </header>
      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <h1 id="hero-title">Your games. All in one place.</h1>
          <p className="hero-description">A new home for your game library.<br />Join the waitlist, then take a look around.</p>
          <WaitlistForm siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ""} privacyUrl={privacyUrl} />
        </section>
        <DesktopDemo />
      </main>
    </>
  );
}
