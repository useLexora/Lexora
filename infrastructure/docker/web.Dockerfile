FROM node:26-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN npm install --global pnpm@12.5.1
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches patches
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --filter @uselexora/lexora-web... --frozen-lockfile --ignore-scripts
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @uselexora/lexora-web build

FROM nginx:1.30-alpine
COPY infrastructure/docker/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
