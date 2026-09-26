FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate
WORKDIR /app

FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/protocol/package.json ./packages/protocol/
RUN pnpm install --frozen-lockfile --filter @seclettr/crypto... --filter @seclettr/protocol... --filter @seclettr/api...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/crypto ./packages/crypto
COPY packages/protocol ./packages/protocol
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @seclettr/crypto... --filter @seclettr/protocol... --filter @seclettr/api...
RUN pnpm --filter @seclettr/crypto build
RUN pnpm --filter @seclettr/protocol build
RUN pnpm --filter @seclettr/api build
# Drop sources and the dev-inclusive dependency tree; the runtime stage swaps in
# a production-only node_modules so the image does not ship build tooling.
RUN rm -rf apps/api/src packages/crypto/src packages/protocol/src node_modules

# Production-only dependencies, laid out exactly like the build workspace so the
# `@seclettr/*` symlinks and pnpm's `.pnpm` store keep the same paths.
FROM base AS proddeps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/protocol/package.json ./packages/protocol/
RUN pnpm install --frozen-lockfile --prod --filter @seclettr/crypto... --filter @seclettr/protocol... --filter @seclettr/api...

FROM node:22-alpine AS production
ARG SECLETTR_VERSION=0.0.0
ARG GIT_REVISION=
ARG BUILD_TIMESTAMP=
LABEL org.opencontainers.image.title="Seclettr API"
LABEL org.opencontainers.image.version="${SECLETTR_VERSION}"
LABEL org.opencontainers.image.revision="${GIT_REVISION}"
LABEL org.opencontainers.image.created="${BUILD_TIMESTAMP}"
LABEL org.opencontainers.image.source="https://github.com/stepan-pavlenko/seclettr"
WORKDIR /app

COPY --from=build /app /app
COPY --from=proddeps /app/node_modules /app/node_modules

WORKDIR /app/apps/api

ENV NODE_ENV=production
ENV SECLETTR_VERSION=${SECLETTR_VERSION}
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
