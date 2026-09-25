FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/protocol/package.json ./packages/protocol/
RUN pnpm install --frozen-lockfile --filter @seclettr/crypto... --filter @seclettr/protocol... --filter @seclettr/web...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
ARG VITE_API_URL=/api
ARG VITE_SFU_URL=/sfu
ARG VITE_ENABLE_DIRECT_CALL_FRAME_E2EE=true
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_SFU_URL=${VITE_SFU_URL}
ENV VITE_ENABLE_DIRECT_CALL_FRAME_E2EE=${VITE_ENABLE_DIRECT_CALL_FRAME_E2EE}
RUN pnpm install --frozen-lockfile --filter @seclettr/crypto... --filter @seclettr/protocol... --filter @seclettr/web...
RUN pnpm --filter @seclettr/crypto build
RUN pnpm --filter @seclettr/protocol build
RUN pnpm --filter @seclettr/web build

FROM nginxinc/nginx-unprivileged:alpine AS production
ARG SECLETTR_VERSION=0.0.0
ARG GIT_REVISION=
ARG BUILD_TIMESTAMP=
LABEL org.opencontainers.image.title="Seclettr Web"
LABEL org.opencontainers.image.version="${SECLETTR_VERSION}"
LABEL org.opencontainers.image.revision="${GIT_REVISION}"
LABEL org.opencontainers.image.created="${BUILD_TIMESTAMP}"
LABEL org.opencontainers.image.source="https://github.com/stepan-pavlenko/seclettr"
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
