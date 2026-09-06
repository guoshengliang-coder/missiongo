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
const sdkIntegrationDownloadPath = "/downloads/missiongo-android-sdk/INTEGRATION.md";
const sdkIntegrationSourcePath = resolve(repositoryRoot, "sdks/android-feedback/INTEGRATION.md");
// Keep in sync with MISSIONGO_SKILL_ORIGIN_PLACEHOLDER in packages/contracts/src/skill.ts
// and the sed substitutions in deploy/Dockerfile.
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
 * Serve a published Markdown document during dev and preview: the AI Skill, and the Android
 * SDK host-integration guide. Production publishes both from deploy/Dockerfile, which
 * substitutes the origin at image build time; neither file lives in public/, so without this
 * the documented URL cannot be verified locally.
 *
 * They stay two separate documents on purpose. The Skill is read on every work-item lookup;
 * the integration guide is read once, by whoever wires the SDK into a host app. Merging them
 * would load Gradle instructions into every agent that only wanted to read HG-8.
 */
function markdownDownload(
  name: string,
  downloadPath: string,
  sourcePath: string,
  publicOrigin: string | undefined,
): Plugin {
  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    if (request.url?.split("?", 1)[0] !== downloadPath) {
      next();
      return;
    }

    const document = readFileSync(sourcePath, "utf8")
      .replaceAll(skillOriginPlaceholder, publicOrigin ?? "http://127.0.0.1:5173");
    response.setHeader("Content-Type", "text/markdown; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    response.end(document);
  };

  return {
    name,
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
      markdownDownload("missiongo-skill-download", skillDownloadPath, skillSourcePath, publicOrigin),
      markdownDownload(
        "missiongo-sdk-integration-download",
        sdkIntegrationDownloadPath,
        sdkIntegrationSourcePath,
        publicOrigin,
      ),
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
