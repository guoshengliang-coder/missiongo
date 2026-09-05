import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const androidDownloadPath = "/downloads/missiongo-android-latest.apk";

function androidDownloadHeaders(): Plugin {
  return {
    name: "missiongo-android-download-headers",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] === androidDownloadPath) {
          response.setHeader("Content-Type", "application/vnd.android.package-archive");
          response.setHeader("Content-Disposition", 'attachment; filename="missiongo-android-latest.apk"');
          response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] === androidDownloadPath) {
          response.setHeader("Content-Type", "application/vnd.android.package-archive");
          response.setHeader("Content-Disposition", 'attachment; filename="missiongo-android-latest.apk"');
          response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        }
        next();
      });
    },
  };
}

function readPublicOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("MISSIONGO_PUBLIC_ORIGIN must be an HTTP(S) origin without a path, query, or credentials.");
  }

  return url.origin;
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");
  const serverTarget = environment.MISSIONGO_DEV_SERVER_URL || "http://127.0.0.1:8787";
  const publicOrigin = readPublicOrigin(environment.MISSIONGO_PUBLIC_ORIGIN);

  return {
    envDir: repositoryRoot,
    plugins: [
      react(),
      androidDownloadHeaders(),
      {
        name: "missiongo-social-image",
        transformIndexHtml() {
          if (!publicOrigin) {
            return [];
          }

          const imageUrl = `${publicOrigin}/og.png`;
          return [
            { tag: "meta", attrs: { property: "og:image", content: imageUrl }, injectTo: "head" },
            { tag: "meta", attrs: { name: "twitter:image", content: imageUrl }, injectTo: "head" },
          ];
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": { target: serverTarget, changeOrigin: false },
        "/health": { target: serverTarget, changeOrigin: false },
      },
    },
    build: {
      target: ["chrome90", "edge90", "firefox90", "safari15.4"],
      cssTarget: "safari15.4",
    },
  };
});
