FROM node:26-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com

RUN npm install --global pnpm@12.5.1 \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --filter @haohaoxue/lexora-api... --frozen-lockfile

COPY packages/contracts packages/contracts
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @haohaoxue/lexora-api build

FROM node:26-slim

ENV PNPM_HOME=/pnpm
ENV NODE_ENV=production
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com

RUN npm install --global pnpm@12.5.1 \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/apps/api /pnpm \
  && chown -R node:node /app /pnpm

ENV PATH="/app/apps/api/node_modules/.bin:/app/node_modules/.bin:${PNPM_HOME}:${PATH}"

WORKDIR /app

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node apps/api/assets apps/api/assets
COPY --chown=node:node apps/api/prisma apps/api/prisma
COPY --chown=node:node apps/api/prisma.config.ts apps/api/prisma.config.ts

USER node

RUN pnpm install --filter @haohaoxue/lexora-api --prod --frozen-lockfile \
  && rm -rf apps/api/node_modules/@haohaoxue

COPY --chown=node:node --from=build /workspace/apps/api/dist /app/apps/api/dist

WORKDIR /app/apps/api

EXPOSE 3000

CMD ["node", "dist/main.mjs"]
