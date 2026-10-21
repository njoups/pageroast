# Build context: civicsignal/ (monorepo root)
# Base image pinned by digest for reproducible builds. Update deliberately (docs/SUPPLY_CHAIN.md): pull the new tag, take
# its digest, rebuild and let CI's Trivy scan pass before merging.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
FROM $NODE_IMAGE AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api --include-workspace-root
COPY apps/api apps/api
RUN npm run build -w apps/api && npm prune --omit=dev -w apps/api

FROM $NODE_IMAGE
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/njoups/pageroast" org.opencontainers.image.revision=$GIT_SHA
# Runtime hardening: current Debian security updates; no package manager in the runtime image (the app runs with node;
# migrations run with node dist/database/migrate-cli.js). Trivy scans this stage in CI (docs/SUPPLY_CHAIN.md).
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/assets apps/api/assets
COPY db db
# Numeric uid of the image's unprivileged "node" user, so orchestrators can verify it is not root.
USER 1000:1000
EXPOSE 4000
# Readiness (database, Redis, migrations). The worker overrides this with its heartbeat check (compose files).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://localhost:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# SIGTERM: the API drains (Nest shutdown hooks); the worker finishes in-flight jobs before exiting (src/worker.ts).
STOPSIGNAL SIGTERM
CMD ["node", "apps/api/dist/main.js"]
