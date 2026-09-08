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

/**
 * Emit a `modulepreload` hint for the console chunk.
 *
 * Vite only emits these for a chunk's *static* imports. main.tsx picks its page
 * with a runtime ternary, so the page chunk is invisible to the HTML and the
 * browser cannot discover it until the entry chunk has been downloaded *and
 * executed*. Measured against production that cost a full extra round trip: the
 * entry chunk landed at 1238ms and the console chunk was not even requested
 * until 1249ms, pushing the first API call out to 1611ms.
 *
 * The hint necessarily lands in the one document nginx serves for every route,
 * so /sdk/feedback preloads a chunk it never runs. That is a real cost on the
 * connection the split was built to protect, and it buys the console a round
 * trip; if the feedback form ever needs it back, the fix is a second HTML entry
 * for that route rather than dropping the hint. An inline script that picked the
 * chunk by pathname would avoid the waste, but the deployed CSP is
 * `script-src 'self'`, so it would never run.
 */
function consoleChunkPreload(): Plugin {
  let base = "/";
  return {
    name: "missiongo-console-chunk-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        const bundle = context.bundle;
        if (!bundle) return [];
        const chunk = Object.values(bundle).find(
          (item) => item.type === "chunk" && item.facadeModuleId?.endsWith("/src/App.tsx"),
        );
        if (!chunk) {
          // A silent miss would look like a performance regression with no cause,
          // so fail the build instead: the file was renamed or the split changed.
          throw new Error("missiongo-console-chunk-preload: no chunk for src/App.tsx in the bundle.");
        }
        return [{
          tag: "link",
          attrs: {
            rel: "modulepreload",
            crossorigin: "",
            href: `${base}${chunk.fileName}`,
          },
          injectTo: "head",
        }];
      },
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
      consoleChunkPreload(),
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
    // The same proxy for `vite preview`. Dev serves unbundled modules, so it is
    // the wrong place to check anything about chunks -- load order, preload
    // hints, how much JS runs before the first request. Preview serves the real
    // build, and without this it cannot reach the API, which made the one mode
    // that reflects production useless for measuring it.
    preview: {
      host: "127.0.0.1",
      proxy: {
        "/api": { target: serverTarget, changeOrigin: false },
        "/health": { target: serverTarget, changeOrigin: false },
      },
    },
    define: {
      // Busts the persisted query cache on every build. A deploy can change the
      // shape of what a query returns, and hydrating the old shape into new
      // components is how a cache like that breaks a screen rather than
      // speeding it up. See query-persistence.ts.
      MISSIONGO_BUILD_STAMP: JSON.stringify(`${Date.now().toString(36)}`),
    },
    build: {
      target: ["chrome90", "edge90", "firefox90", "safari15.4"],
      cssTarget: "safari15.4",
    },
  };
});
