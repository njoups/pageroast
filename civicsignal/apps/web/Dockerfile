# Build context: civicsignal/ (monorepo root)
# Base image pinned by digest for reproducible builds. Update deliberately (docs/SUPPLY_CHAIN.md): pull the new tag, take
# its digest, rebuild and let CI's Trivy scan pass before merging.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
FROM $NODE_IMAGE AS build
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

FROM $NODE_IMAGE
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/njoups/pageroast" org.opencontainers.image.revision=$GIT_SHA
# Runtime hardening: current Debian security updates; no package manager in the runtime image (the app runs with node
# only). Trivy scans this stage in CI (docs/SUPPLY_CHAIN.md).
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ARG API_INTERNAL_URL=http://api:4000
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_INTERNAL_URL=$API_INTERNAL_URL
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/web apps/web
# Numeric uid of the image's unprivileged "node" user, so orchestrators can verify it is not root.
USER 1000:1000
EXPOSE 3000
WORKDIR /app/apps/web
# Liveness of the web process only; /readyz checks the API end to end.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "-p", "3000"]
