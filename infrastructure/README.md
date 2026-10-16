# 插件社区

当前处于本地开发与测试阶段，未接入默认构建、CI 或正式发布。

社区由 Web、API 和 PostgreSQL 组成。插件安装包通过发布者提供的 HTTPS 地址下载。

## 本地开发

```sh
cp infrastructure/.env.dev.example infrastructure/.env
pnpm dev:infra
pnpm dev:db:sync
pnpm dev:web-stack
```

打开 `http://localhost:5173`。需要登录时，填写 OAuth 客户端配置。

## 部署草案

以下配置尚未完成部署验收，暂不用于正式环境。

```sh
cp infrastructure/.env.example infrastructure/.env.prod
docker build -f infrastructure/docker/api.Dockerfile -t uselexora/lexora-api:latest .
docker build -f infrastructure/docker/web.Dockerfile -t uselexora/lexora-web:latest .
docker compose --env-file infrastructure/.env.prod -f infrastructure/compose.prod.yml up -d
```

填写新的 PostgreSQL 密码和连接串。连接串中的密码需要 URL 编码。社区使用独立数据库和 volume，不接受历史文档应用的数据库。上面命令只在本机 `127.0.0.1:8080` 暴露 Web，需要外部 HTTPS 反向代理。

已有 Traefik 时改用 `compose.traefik.prod.yml`。它使用外部 `traefik` 网络、`web` / `websecure` 入口、`https-redirect@file` 中间件及已有证书配置。默认域名为 `plugins.uselexora.app`。

三方登录回调地址分别为：

- `https://plugins.uselexora.app/api/auth/github/callback`
- `https://plugins.uselexora.app/api/auth/google/callback`
- `https://plugins.uselexora.app/api/auth/linux-do/callback`

`LEXORA_ADMIN_IDENTITIES` 使用逗号分隔的平台固定用户 ID，例如 `github:123456`。管理员在登录后的账号信息中核对 ID；不要填写昵称或邮箱。未配置的登录方式不会展示。`OAUTH_PROXY_URL` 可使用现有 OAuth 出站代理。

## 导入已有插件

发布者先登录社区。管理员核实作者归属、安装包和校验值后，可以导入已有目录，保留原插件 ID：

```sh
pnpm --filter @uselexora/lexora-api catalog:import --file /absolute/path/catalog.json --owner github:123456 --publisher lexora --name Lexora
```

命令读取本地 JSON，结构为 `{ "schemaVersion": 1, "plugins": [...] }`；每项包含完整 `manifest`、`repository` 和 `artifact`（`url`、`sha256`、`size`）。已有版本只允许相同内容的重复导入。生产镜像中的入口为 `node dist/cli/import-catalog.mjs`，参数相同。

新插件 ID 使用发布者用户名作为前缀，例如 `alice.weather`。显示名称可以重复，用户名、插件 ID 和每个版本的内容保持稳定。普通提交需审核后才公开。
