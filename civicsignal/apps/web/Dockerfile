# Build context: civicsignal/ (monorepo root)
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web --include-workspace-root
COPY apps/web apps/web
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN npm run build -w apps/web && npm prune --omit=dev -w apps/web

FROM node:22-bookworm-slim
# Runtime hardening: current Debian security updates; no package manager in the runtime image (the app runs with node;
# the compose migrate service uses the build stage). Trivy scans this stage in CI (docs/SUPPLY_CHAIN.md).
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/web apps/web
USER node
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "-p", "3000"]
