import Link from "next/link";
import { DesktopDemo } from "@/components/desktop-demo";
import { DesktopDownloads } from "@/components/desktop-downloads";
import { getDesktopRelease } from "@/lib/releases";

export const revalidate = 900;

export default async function Home() {
  const release = await getDesktopRelease();
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
          <p className="hero-description">A new home for your game library.<br />Download the desktop app, or take a look around.</p>
          <DesktopDownloads release={release} />
        </section>
        <DesktopDemo />
      </main>
    </>
  );
}
