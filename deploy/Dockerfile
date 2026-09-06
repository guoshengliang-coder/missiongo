FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY services/server/package.json services/server/package.json

RUN npm ci

COPY tsconfig.json tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/contracts packages/contracts
COPY packages/domain packages/domain
COPY services/server services/server

ARG MISSIONGO_PUBLIC_ORIGIN
ENV MISSIONGO_PUBLIC_ORIGIN=${MISSIONGO_PUBLIC_ORIGIN}

RUN npx tsc -b packages/domain packages/contracts services/server --force \
  && npm run build --workspace @missiongo/web \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS server

ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8787 \
    DATABASE_PATH=/data/missiongo.sqlite \
    ATTACHMENTS_PATH=/data/attachments

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/domain ./packages/domain
COPY --from=builder /app/packages/contracts ./packages/contracts
COPY --from=builder /app/services/server ./services/server

RUN mkdir -p /data/attachments \
  && chown -R node:node /app /data

USER node

EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "services/server/dist/main.js"]

FROM nginx:1.29-alpine AS web

ARG MISSIONGO_PUBLIC_ORIGIN

COPY deploy/nginx-container.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY skills/missiongo/SKILL.md /tmp/missiongo-SKILL.md
COPY sdks/android-feedback/INTEGRATION.md /tmp/missiongo-sdk-INTEGRATION.md

RUN test -n "${MISSIONGO_PUBLIC_ORIGIN}" \
  && mkdir -p /usr/share/nginx/html/downloads/missiongo-skill \
  && sed "s|__MISSIONGO_PUBLIC_ORIGIN__|${MISSIONGO_PUBLIC_ORIGIN%/}|g" \
    /tmp/missiongo-SKILL.md \
    > /usr/share/nginx/html/downloads/missiongo-skill/SKILL.md \
  && rm /tmp/missiongo-SKILL.md \
  && ! grep -q "__MISSIONGO_PUBLIC_ORIGIN__" /usr/share/nginx/html/downloads/missiongo-skill/SKILL.md

# The Android SDK host-integration guide. A host app's developer or coding agent is handed this
# one URL and needs nothing else, so like the Skill it is published at a fixed address with the
# origin substituted in, and the build fails if any placeholder survives.
RUN test -n "${MISSIONGO_PUBLIC_ORIGIN}" \
  && mkdir -p /usr/share/nginx/html/downloads/missiongo-android-sdk \
  && sed "s|__MISSIONGO_PUBLIC_ORIGIN__|${MISSIONGO_PUBLIC_ORIGIN%/}|g" \
    /tmp/missiongo-sdk-INTEGRATION.md \
    > /usr/share/nginx/html/downloads/missiongo-android-sdk/INTEGRATION.md \
  && rm /tmp/missiongo-sdk-INTEGRATION.md \
  && ! grep -q "__MISSIONGO_PUBLIC_ORIGIN__" /usr/share/nginx/html/downloads/missiongo-android-sdk/INTEGRATION.md

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD ["wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1:8080/health"]
