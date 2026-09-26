FROM node:22-alpine AS base
RUN apk add --no-cache python3 py3-pip make g++ linux-headers
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/sfu/package.json ./apps/sfu/
COPY packages/protocol/package.json ./packages/protocol/
RUN pnpm install --frozen-lockfile --filter @seclettr/protocol... --filter @seclettr/sfu...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/sfu ./apps/sfu
RUN pnpm install --frozen-lockfile --filter @seclettr/protocol... --filter @seclettr/sfu...
RUN pnpm --filter @seclettr/protocol build
RUN pnpm --filter @seclettr/sfu build
# Drop sources and the dev-inclusive dependency tree; the runtime stage swaps in
# a production-only node_modules so the image does not ship build tooling.
RUN rm -rf apps/sfu/src packages/protocol/src node_modules

# Production-only dependencies, including the compiled mediasoup worker. Reuses
# the toolchain installed in `base` and keeps pnpm's exact path layout.
FROM base AS proddeps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/sfu/package.json ./apps/sfu/
COPY packages/protocol/package.json ./packages/protocol/
RUN pnpm install --frozen-lockfile --prod --filter @seclettr/protocol... --filter @seclettr/sfu...

FROM node:22-alpine AS production
ARG SECLETTR_VERSION=0.0.0
ARG GIT_REVISION=
ARG BUILD_TIMESTAMP=
LABEL org.opencontainers.image.title="Seclettr SFU"
LABEL org.opencontainers.image.version="${SECLETTR_VERSION}"
LABEL org.opencontainers.image.revision="${GIT_REVISION}"
LABEL org.opencontainers.image.created="${BUILD_TIMESTAMP}"
LABEL org.opencontainers.image.source="https://github.com/stepan-pavlenko/seclettr"
RUN apk add --no-cache libstdc++
WORKDIR /app

COPY --from=build /app /app
COPY --from=proddeps /app/node_modules /app/node_modules

WORKDIR /app/apps/sfu

ENV NODE_ENV=production
USER node
EXPOSE 3002
CMD ["node", "dist/index.js"]
