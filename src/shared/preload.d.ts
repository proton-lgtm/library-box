import type { DesktopApi } from "./types";

declare global {
  interface Window {
    library: DesktopApi;
  }
}

export {};
