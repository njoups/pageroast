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
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/web apps/web
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "apps/web"]
