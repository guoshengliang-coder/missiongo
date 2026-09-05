import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const androidDownloadPath = "/downloads/missiongo-android-latest.apk";
const skillDownloadPath = "/downloads/missiongo-skill/SKILL.md";
const skillSourcePath = resolve(repositoryRoot, "skills/missiongo/SKILL.md");
// Keep in sync with MISSIONGO_SKILL_ORIGIN_PLACEHOLDER in packages/contracts/src/skill.ts
// and the sed substitution in deploy/Dockerfile.
const skillOriginPlaceholder = "__MISSIONGO_PUBLIC_ORIGIN__";

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

/**
 * Serve the published AI Skill during dev and preview. Production publishes this file
 * from deploy/Dockerfile, which substitutes the origin at image build time; the file is
 * not in public/, so without this the documented install URL cannot be verified locally.
 */
function skillDownload(publicOrigin: string | undefined): Plugin {
  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    if (request.url?.split("?", 1)[0] !== skillDownloadPath) {
      next();
      return;
    }

    const skill = readFileSync(skillSourcePath, "utf8")
      .replaceAll(skillOriginPlaceholder, publicOrigin ?? "http://127.0.0.1:5173");
    response.setHeader("Content-Type", "text/markdown; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    response.end(skill);
  };

  return {
    name: "missiongo-skill-download",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
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
      skillDownload(publicOrigin),
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
