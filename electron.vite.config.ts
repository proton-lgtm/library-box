import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "NEXT_PUBLIC_");
  return {
    main: {
      define: {
        __SUPABASE_URL__: JSON.stringify(env.NEXT_PUBLIC_SUPABASE_URL ?? ""),
        __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ""),
      },
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: resolve(__dirname, "electron/main/index.ts"),
          output: {
            format: "cjs",
            entryFileNames: "index.cjs",
          },
        },
      },
    },
    preload: {
      build: {
        rollupOptions: {
          input: resolve(__dirname, "electron/preload/index.ts"),
          output: {
            format: "cjs",
            entryFileNames: "index.cjs",
          },
        },
      },
    },
    renderer: {
      root: ".",
      base: "./",
      plugins: [react()],
      resolve: {
        alias: {
          "@": resolve(__dirname, "src"),
        },
      },
      build: {
        rollupOptions: {
          input: resolve(__dirname, "index.html"),
        },
      },
    },
  };
});
