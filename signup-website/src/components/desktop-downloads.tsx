import type { DesktopRelease, DownloadAsset } from "@/lib/releases";

const platforms = [
  { name: "Windows", formats: [{ kind: "windows-installer", label: "Installer (.exe)" }, { kind: "windows-portable", label: "Portable (.exe)" }] },
  { name: "Linux", formats: [{ kind: "linux-appimage", label: "AppImage" }, { kind: "linux-deb", label: "Debian / Ubuntu (.deb)" }] },
  { name: "macOS", formats: [{ kind: "macos-dmg", label: "Disk image (.dmg)" }] },
] as const;

function architectureLabel(asset: DownloadAsset) {
  if (asset.kind !== "macos-dmg") return asset.architecture;
  if (asset.architecture === "ARM64") return "Apple silicon (ARM64)";
  if (asset.architecture === "x64 (Intel / AMD)") return "Intel (x64)";
  return asset.architecture;
}

export function DesktopDownloads({ release }: { release: DesktopRelease }) {
  return (
    <section id="downloads" className="downloads" aria-labelledby="downloads-title">
      <h2 id="downloads-title">Download Playmart</h2>
      <p className="release-summary">
        {release.tag ? <>Public release {release.tag}. </> : <>Release availability could not be checked. </>}
        <a href={release.url}>{release.tag ? "Release notes & all files" : "View GitHub Releases"} <span aria-hidden="true">↗</span></a>
      </p>
      <div className="download-platforms">
        {platforms.map((platform) => (
          <section className="download-platform" key={platform.name} aria-label={`${platform.name} downloads`}>
            <h3>{platform.name}</h3>
            {platform.formats.map((format) => {
              const assets = release.assets.filter((asset) => asset.kind === format.kind);
              return assets.length ? assets.map((asset) => (
                <a className="download-button" href={asset.url} key={asset.name} title={asset.name}>
                  <span>Download {format.label} <span aria-hidden="true">↓</span></span>
                  <small>{architectureLabel(asset)}</small>
                </a>
              )) : (
                <div className="download-unavailable" key={format.kind}>
                  <span>{format.label}</span>
                  <small>{release.tag ? "Not published in this release." : "Availability unconfirmed."}</small>
                  <a href={release.url}>Check release files <span aria-hidden="true">↗</span></a>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <p className="download-note">Choose the package matching your computer’s operating system and processor. If architecture is unspecified, check the release notes before installing. No waitlist signup required.</p>
    </section>
  );
}
