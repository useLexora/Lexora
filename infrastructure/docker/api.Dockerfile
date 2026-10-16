FROM node:26-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN npm install --global pnpm@12.5.1 \
  && apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches patches
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --filter @uselexora/lexora-api... --frozen-lockfile --ignore-scripts
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @uselexora/lexora-api build \
  && pnpm --config.allow-unused-patches=true --filter @uselexora/lexora-api deploy --prod --legacy /out \
  && cd /out && node_modules/.bin/prisma generate

FROM node:26-bookworm-slim
ENV NODE_ENV=production
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
CMD ["node", "dist/main.mjs"]
