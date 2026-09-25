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

FROM node:22-alpine AS production
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate
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

WORKDIR /app/apps/api

ENV NODE_ENV=production
ENV SECLETTR_VERSION=${SECLETTR_VERSION}
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
