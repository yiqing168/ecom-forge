# 10 工程架构、目录与部署

| 项       | 内容                                                                                 |
| -------- | ------------------------------------------------------------------------------------ |
| 状态     | v0.4 S08 Agent/Skill 运行与部署约束回写后待复审                                      |
| 基准     | PRD v1.7、01-09 阶段 0 契约                                                          |
| 完成节点 | Bootstrap 前                                                                         |
| 裁决范围 | 工程技术栈、pnpm monorepo 目录、服务边界、本地开发、国内部署拓扑、环境变量和演进路径 |
| 不裁决   | 业务状态机、表字段、具体 UI、Provider PoC 结果                                       |

## 1. 目标

2026-10-12 本地启动交付补充：根 README 为公开项目与启动指引。首次检出可执行
`node scripts/setup-local.mjs`，从 `.env.example` 生成仅本机使用的 `.env.local`，
独立生成各密钥域并使用本地 Docker Compose 的数据库/Redis 连接；禁止覆盖已有文件。
不从维护者私密配置复制任何值，不生成 Provider API Key，不写入运行限制默认值。
本地 Worker 消费开关由现有 dev 入口设置，不放进 API 共用配置。生产仍须独立注入
最小环境集、真实服务与密钥管理配置。稳定 Worker 的独立 dev 入口必须先构建
workspace 依赖，再校验 Skill，任一步失败都不启动消费者，避免首次检出缺 dist。
启动验收区分页面可访问、基础设施 ready、
管理员初始化和真实模型可用；模型探测/生成可能收费，不能作为默认安装动作。

本文定义代码工程启动前的产品级工程骨架和部署策略。当前仓库仍处于文档阶段，尚未创建实际工程代码；后续 Bootstrap 必须按本文结构创建。

核心目标：

- 支持对话 Agent、Workflow、Provider、账本和 SSE 的长期演进。
- 本地开发默认 0 基础设施成本，使用 Docker PostgreSQL、Docker Redis 和本地文件存储。
- 面向中国用户，内测和生产优先使用国内云服务与国内模型 Provider。
- 海外 Vercel/Railway/Neon/Vercel Blob 只作为海外备选，不作为默认上线方案。
- 工程目录必须支持前后端、Worker、DB schema、共享类型和测试脚本分离。

## 2. 技术栈裁决

阶段 0 推荐：

| 层                | 选择                                                            | 说明                                                                  |
| ----------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| 运行时与包管理    | Node.js 22 LTS + Corepack + pnpm 11 workspace                   | 产品级 monorepo，锁定已验证的 Node `22.22.3` 与 pnpm `11.7.0`         |
| 前端              | Next.js App Router                                              | 页面、RSC、轻量 BFF、Server Actions                                   |
| 后端 API          | NestJS                                                          | Agent、Workflow、Provider、Credit、Asset、Admin、Webhook、SSE         |
| Worker            | NestJS 独立 entrypoint 或独立 Node worker                       | BullMQ 常驻进程，和 HTTP API 可分进程部署                             |
| DB                | PostgreSQL + Drizzle                                            | schema、migration 和查询类型统一管理                                  |
| 队列/缓存         | Redis + BullMQ                                                  | task、agent、provider-callback、evaluation、notification              |
| 对象存储          | 本地文件系统开发；腾讯云 COS/阿里云 OSS 生产                    | 通过统一 StorageAdapter 抽象                                          |
| 认证              | Better Auth 接入 NestJS API，或同等邮箱认证                     | session/token 由 API 统一校验，web 只转发认证态                       |
| LLM 调用          | Vercel AI SDK 的 `ai` 核心包或 OpenAI SDK 封装                  | 必须支持 tool-calling、结构化输出、trace 和预算；具体模型由 `03` 裁决 |
| LLM/图片 Provider | 本地假 Provider/Ollama/SD 用于开发；国内 relay API 优先用于内测 | OpenAI/Anthropic/Google Brain 协议 relay 可作为受控备选               |

选择理由：

- Next.js 适合构建前端体验，但不承载核心长任务和交易状态机。
- NestJS 更适合常驻后端、模块边界、依赖注入、SSE、Webhook、Cron 和 Worker。
- BullMQ 自动重试能力必须受 `04` 的 dispatch_state 约束，不能直接把 BullMQ attempts 当业务重试策略。
- SSE 只做投影，事件真相仍来自 `event_outbox`。
- LLM SDK 只是调用层工具，不裁决 Agent 行为；Agent 循环、Skill 渐进加载、权限和费用语义以 `02` 为准。
- Better Auth 若接在 `apps/web` 作为 BFF 认证层，也必须由 `apps/api` 进行最终 token/session 校验。

## 3. 标准工程目录

Bootstrap 后目标目录：

```text
ecom-forge/
  apps/
    web/                         # Next.js 前端与轻量 BFF
      app/
      components/
      features/
      lib/
      public/
    api/                         # NestJS HTTP API、SSE、Webhook、Admin
      src/
        modules/
          agent/
          workflow/
          provider/
          credit/
          asset/
          product/
          sse/
          admin/
          health/
        shared/
          auth/
          config/
          database/
          queue/
          storage/
          observability/
        main.ts
    worker/                      # 常驻 Worker 与 Cron，可复用 Nest modules
      src/
        processors/
          agent.processor.ts
          workflow.processor.ts
          provider-callback.processor.ts
          evaluation.processor.ts
          notification.processor.ts
        crons/
          ledger-reconcile.cron.ts
          outcome-unknown-sweeper.cron.ts
        main.ts
  packages/
    db/                          # Drizzle schema、migration、seed
      src/schema/
      migrations/
    types/                       # DTO、事件、状态枚举、API 响应类型
      src/
    shared/                      # 幂等、canonical hash、错误码、成本公式
      src/
    agent/                        # Agent turn、上下文、tool loop 与纯运行时契约
      src/
    compiler/                     # 确定性计划编译与 R1-R5 校验
      src/
    credit/                       # quote、reservation、ledger、settlement
      src/
    provider/                     # Provider gateway 和适配器
      src/
    queue/                        # BullMQ payload、队列和 worker contract
      src/
    skills/                      # 版本化知识包、schema/path/hash 纯逻辑与渐进资源
      commerce-white-background/
        SKILL.md
        references/
  scripts/
    poc/
    validation/
    ops/
  docs/
  docker-compose.yml
  pnpm-workspace.yaml
  package.json
  turbo.json
```

目录规则：

- `apps/web` 不直接访问数据库，不直接写账本。
- `apps/api` 是 API、权限、交易事务和状态裁决入口。
- `apps/worker` 只按数据库状态推进任务，不持有内存真相。
- `packages/db` 只定义 schema/migration，不放业务服务。
- `packages/types` 不依赖应用层代码，保证前后端共享安全。
- `packages/shared` 只放无副作用工具，不能调用 DB、Redis 或 Provider。
- `packages/agent` 只负责 turn/context/loop runtime，不拥有收费裁决。
- `packages/compiler` 是收费动作和产物引用的确定性校验边界。
- `packages/credit` 是唯一允许写资金流水的业务包。
- `packages/provider` 统一 Provider adapter、回执和成本快照。
- `packages/queue` 只定义队列 payload、job 幂等和调度基础。
- `packages/agent` 和 `packages/skills` 保持无 I/O，不读 DB/Redis/HTTP/env/filesystem；Worker adapter 承担发布包、DB snapshot 和 Redis cache I/O。
- Skill 文件可以在 `packages/skills`，但 Skill 是知识包而非工具授权；运行时必须按 `02` 的 L0/L1/L2 渐进加载。
- `packages/skills` 同时提供纯 manifest/schema/path/hash/dependency validator；archive I/O、quarantine、对象存储和发布事务位于 API/ops adapter。新增 Skill 走标准 package installer，不要求修改 Agent loop；安装包不得携带可执行 hook、工具或 migration。

## 4. 应用边界

### web

职责：

- Agent 工作台、商品管理、我的资产、我的作品、积分明细和用户任务日志。
- Server Actions 可做轻量页面数据聚合和转发。
- SSE 客户端、heartbeat watchdog、断线 `last_event_seq` 恢复。

禁止：

- 直接计算费用。
- 直接调用 Provider。
- 直接创建 `credit_ledger` 或修改 `credit_accounts`。
- 直接用前端状态判断产物修改权。

### api

职责：

- `/api/v1` HTTP API。
- Better Auth 或同等认证接入。
- Agent turn 创建、确认、中断。
- run_quote 编译、submit、同事务 reservation + workflow_run。
- Provider webhook 验签和回执归一化。
- SSE outbox 投影。
- 运营后台 API 和审计。

Provider webhook 入口必须由 Nest 以 raw body 模式启动，并只对 `/api/v1/webhooks/providers/{provider}` 使用有上限的原始字节进行验签；raw body 不得挂到通用日志、异常序列化或队列。普通 JSON API 继续使用严格 DTO/schema 校验，不能因为 webhook 开启 raw body 而绕过全局请求校验。

Agent 分界：

- API 同步处理：创建 turn、保存用户消息、确认/中断 turn、返回 `turn_id`、校验权限和幂等键。
- API 不同步执行：意图分类、上下文组装、LLM 循环、Skill 加载、计划编译等耗时步骤。
- API 创建 turn 后入队 `agent` job，由 `apps/worker/src/processors/agent.processor.ts` 异步推进。
- 所有进度通过 `event_outbox` + SSE 投影给前端。
- API/Worker 对外只投影安全 `activity_type/display_summary`；内部 tool name、args hash、Skill 正文和错误原文只留在受控 trace。

### worker

职责：

- BullMQ processors。
- Provider 投递、轮询和下载产物。
- evaluation、notification、asset 后处理。
- Cron：ledger replay、outcome_unknown 30 分钟自动释放、worker heartbeat 扫描、成本报告。

禁止：

- Worker 不得绕过 API/服务层直接自造费用语义。
- `accepted/outcome_unknown` 不得依赖 BullMQ 自动 attempts 重试。
- 任何补偿动作必须写入 ledger/event_outbox。
- Worker 完成 task 后只能触发 `06` 定义的 settlement job；Credit 服务是唯一结算入口。
- Agent processor 只能从服务端静态 Tool registry 取得当前 action space；S08 production registry 只含 `load_skill@1`，test tool 只能由 test composition root 注入。
- Skill package validation 使用独立低权限 Worker pool/任务：无网络、无 Provider/邮件/数据库管理密钥、无用户数据，只可读指定 quarantine/content-addressed artifact，并通过窄 repository claim/renew/写指定 validation report。进程配置 CPU/内存/临时磁盘/执行时限，临时目录按 report ID 隔离且任务结束即清理；archive 绝不解包到应用源码或共享运行目录。
- package approval Service 只以持久化 package/report/resource ID+hash 在短事务物化不可变 Skill snapshot；catalog release Service 再单独创建完整 closure 并原子切 active pointer。validation、approval、release publish 三者不能合成一个长事务或一个“安装即上线”动作。
- 作者 CLI 与 S14 Admin API 复用 `packages/skills` 的同一 schema/canonicalizer/diff；`skill:pack` 的可复现 archive 不包含开发脚本或 Git 元数据。staging/beta/production 不部署本地 approve/publish bootstrap 命令，避免绕过 Admin Session/MFA/permission。

## 5. 本地开发拓扑

本地开发默认 0 基础设施成本：

```text
浏览器
  -> apps/web  http://localhost:3000
  -> apps/api  http://localhost:3001
  -> apps/worker
  -> Docker PostgreSQL localhost:5432
  -> Docker Redis localhost:6379
  -> 本地 ./uploads
  -> Fake Provider / Ollama / 本地 Stable Diffusion 可选
```

本地基础服务：

```yaml
services:
  postgres:
    image: postgres:16
    ports:
      - '127.0.0.1:5432:5432'
    environment:
      POSTGRES_USER: ecom_forge
      POSTGRES_PASSWORD: ecom_forge_dev
      POSTGRES_DB: ecom_forge

  redis:
    image: redis:7
    ports:
      - '127.0.0.1:6379:6379'
    command: ['redis-server', '--appendonly', 'yes']
```

本地命令约定：

```bash
pnpm install
docker compose up -d
pnpm db:migrate
pnpm dev
```

开发 Provider 分层：

| 类型       | 默认策略                                                                    |
| ---------- | --------------------------------------------------------------------------- |
| Agent 大脑 | deterministic fake；真实模型在 S14 控制面完成后由受控 PoC/已审批 route 启用 |
| 图片生成   | Fake image provider；有 GPU 时可接本地 Stable Diffusion                     |
| 图片编辑   | Fake edit provider；PoC 时接国内 Provider                                   |
| 对象存储   | `LocalStorageAdapter` 写入 `./uploads`                                      |

### 5.1 运行环境模型

必须区分框架运行模式和部署环境：

```text
NODE_ENV=development|test|production
APP_ENV=local|test|staging|beta|production
```

- `NODE_ENV` 只控制 Node/框架构建和测试；`APP_ENV` 决定 adapter 准入、网络、密钥、日志和启动门禁。
- staging、beta、production 的 `NODE_ENV` 均为 `production`。
- `APP_ENV` 只能由受信部署配置注入，禁止从 HTTP header、query、客户端配置或 `NEXT_PUBLIC_*` 获取。
- 环境判断集中在各 deployable app 的 typed config loader 和 composition root，业务服务不得散落 `NODE_ENV/APP_ENV` 分支。

| 能力          | local             | test          | staging            | beta                | production           |
| ------------- | ----------------- | ------------- | ------------------ | ------------------- | -------------------- |
| 邮件          | console/本地 SMTP | fake          | 真实受控 smoke     | 真实邮件服务        | 真实邮件服务         |
| PostgreSQL    | Docker PG 16      | 隔离测试库    | 独立测试实例       | 单机或托管实例      | 托管 PostgreSQL/RDS  |
| Redis         | Docker Redis 7    | 隔离测试实例  | 独立测试实例       | 单机或托管 Redis    | 托管 Redis           |
| 二进制存储    | local             | 临时目录/fake | 测试桶             | 香港私有桶          | 正式私有桶           |
| 外部 Provider | fake/封闭 PoC     | fake          | 测试密钥           | 已准入真实 Provider | 已准入真实 Provider  |
| Agent Brain   | fake              | fake          | S14 后已审批 smoke | S14 后已审批模型    | S14/S15 后已审批模型 |

### 5.2 本地认证邮件

- 本地开发不购买、不调用腾讯 SES，默认 `MAIL_PROVIDER=console`；可选 `MAIL_PROVIDER=smtp` 连接本机 Mailpit。
- Mailpit 是开发辅助服务，镜像必须固定版本或 digest，不使用 `latest`；SMTP/Web UI 默认仅绑定 `127.0.0.1:1025` 和 `127.0.0.1:8025`。
- test 使用 FakeMailAdapter 从测试进程读取 OTP，禁止增加返回验证码的 HTTP 调试接口。
- 本地和测试适配器只改变邮件 IO，OTP、邀请码、ticket、限流、奖励和错误语义与生产一致。

## 6. 内测与 Beta 部署拓扑

内测面向中国用户，默认不使用欧美海外托管作为主链路。Beta 推荐优先使用中国香港服务器，原因是部署快、无需大陆 ICP 备案、访问中国大陆延迟通常可接受；当确定长期运营或需要大陆 CDN/大陆机房时，再迁移大陆服务器并完成备案与合规门禁。

### 6.1 推荐方案 A：腾讯云香港轻量服务器

```text
腾讯云香港轻量应用服务器
  -> Nginx
  -> Next.js web
  -> NestJS api
  -> worker process
  -> Docker PostgreSQL
  -> Docker Redis
  -> 本地临时文件缓存

腾讯云 COS 香港桶或服务器本地临时存储
  -> 原图、产物、缩略图

国内模型 Provider
  -> 通义万相 / 火山 / 百度 / 可灵等按 PoC 结果选择
```

beta 目标：

- 20-50 名内测电商卖家。
- 基础设施成本控制在约 100 元/月以内，不含模型 API 成本；实际价格以云厂商购买页为准。
- 单机优先，减少早期运维面。
- 每日自动备份 PostgreSQL。
- Redis 可重建，但队列状态必须可从 DB 恢复。
- 可在 1 天内完成环境准备和上线验证。

推荐配置：

| 资源     | beta 建议                                                 |
| -------- | --------------------------------------------------------- |
| 服务器   | 腾讯云香港轻量 2 核 4G 起，活动价可用但不写入长期成本承诺 |
| 数据库   | beta 可自建 PostgreSQL；production 再拆 RDS               |
| Redis    | beta 可自建 Redis；高并发后拆云 Redis                     |
| 存储     | 腾讯云 COS 香港私有桶；小规模内测可先本地存储但必须可迁移 |
| CDN      | 内测可不开；下载量上来后再接 CDN                          |
| 进程管理 | Docker Compose 或 PM2，二选一固定                         |
| 备份     | 每日 DB dump + COS 生命周期                               |

适用条件：

- 需要快速启动 Beta，不希望等待大陆 ICP 备案。
- 内测用户规模较小，目标是验证产品闭环、Provider、账本和成本。
- 暂不接大陆 CDN，不做大规模公开投放。

限制：

- 香港服务器不等于免除 AI 内容、隐私、用户协议、版权和供应商条款合规。
- 若后续使用大陆服务器、大陆 CDN 或面向大陆公开经营，仍需完成相应备案和合规门禁。
- 活动价和带宽/流量包随云厂商变化，文档不得写死为长期成本。

### 6.2 方案 B：大陆服务器

大陆服务器适合生产和大规模长期运营：

| 项       | 要求                                          |
| -------- | --------------------------------------------- |
| 前置条件 | ICP 备案、域名实名、HTTPS、法务/内容合规复核  |
| 优点     | 大陆访问延迟最低，可接大陆 CDN 和对象存储加速 |
| 使用时机 | 日活 500+、确定长期运营、有专人处理合规和备案 |

迁移触发：

- Beta 数据证明产品值得长期运营。
- 用户规模或下载流量需要大陆 CDN。
- 需要接入大陆支付、发票、企业客户或更严格服务 SLA。

### 6.3 Nginx 反向代理要点

beta 使用单机部署时，Nginx 至少满足：

```nginx
server {
  listen 443 ssl http2;
  server_name example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_read_timeout 120s;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /api/v1/events {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_set_header Connection "";
    chunked_transfer_encoding on;
  }

  location /api/v1/webhooks/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

规则：

- SSE 路径必须关闭 `proxy_buffering`，否则会出现事件延迟堆积。
- Webhook 必须保留真实 IP 和原始签名头。
- 单层 Nginx 必须覆盖客户端伪造的转发头。前置 CDN/LB 时只信任其固定 CIDR，并明确 real-ip hop；不得直接信任任意 XFF 链。
- API 仅在 socket peer 位于 `TRUSTED_PROXY_CIDRS` 时解析代理头；否则忽略全部转发头并使用 remote address。代理拓扑不匹配时 staging/beta/production 健康门禁失败。
- HTTPS 证书可使用腾讯云免费证书或 acme.sh；production 不允许明文 HTTP。

### 6.4 进程管理

beta 二选一固定，不混用：

| 方式           | 适用                                 |
| -------------- | ------------------------------------ |
| Docker Compose | 本地和单机 beta 统一，便于迁移       |
| PM2            | 单机直接 Node 部署，便于查看进程日志 |

最小进程：

```text
web:     Next.js
api:     NestJS API
worker:  BullMQ processors + Cron
nginx:   反向代理和 HTTPS
```

生产发布时必须先启动新进程健康检查，再切流或重启旧进程，避免直接杀掉正在处理的 worker。

PM2 最小配置示例：

```js
module.exports = {
  apps: [
    {
      name: 'ecom-web',
      cwd: '/var/www/ecom-forge/apps/web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      instances: 1,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'ecom-api',
      cwd: '/var/www/ecom-forge/apps/api',
      script: 'dist/main.js',
      instances: 2,
      exec_mode: 'cluster',
      env: { NODE_ENV: 'production', API_PORT: '3001' },
    },
    {
      name: 'ecom-worker',
      cwd: '/var/www/ecom-forge/apps/worker',
      script: 'dist/main.js',
      instances: 1,
      env: { NODE_ENV: 'production' },
    },
  ],
};
```

PM2 规则：

- API 可 cluster；worker 默认单实例起步，扩容时按队列拆 worker 池。
- 发布前先 `pnpm build`，再重启 PM2。
- worker 收到 SIGTERM/SIGINT 后必须暂停领取新 job、heartbeat 置 `draining`、等待 active job 有界完成，再置 `stopped`；超过 drain timeout 后退出并由 BullMQ stalled 检测、DB intent 与 reconciliation 接管。

## 7. 生产部署演进

production 不在法务、域名/备案（如适用）、支付和成本门禁完成前开放。

演进路径：

```text
beta 单机
  -> DB 迁移到云 RDS/PostgreSQL
  -> Redis 迁移到云 Redis
  -> worker 独立服务器
  -> API 多实例
  -> COS + CDN
  -> 多 Provider 熔断和灰度
```

拆分触发条件：

| 触发                       | 动作                           |
| -------------------------- | ------------------------------ |
| DB CPU/IO 长期高于 60%     | 拆 RDS                         |
| Redis 内存或连接接近上限   | 拆云 Redis                     |
| Worker 队列等待 P95 超阈值 | 独立 worker 或增加 worker 实例 |
| 图片下载流量明显增长       | 接 CDN                         |
| Provider unknown 激增      | 熔断模型并暂停放量             |

## 8. 并发扩容预案

扩容原则：

- 先用队列削峰，不让用户请求直接等待 Provider。
- 先拆 Worker，再拆 API；API 保持轻量，重任务只入队。
- 数据库是账本真相，扩容必须优先保护 DB 事务和连接池。
- Provider 并发由模型网关统一限流，不把供应商真实并发暴露给用户。
- SSE 是投影通道，高并发时可以降级为轮询详情 API + 少量关键事件。

### 8.1 容量阶段

| 阶段       |       用户规模 | 推荐拓扑                                                        | 关键动作                                   |
| ---------- | -------------: | --------------------------------------------------------------- | ------------------------------------------ |
| beta 单机  | 20-50 内测用户 | 1 台轻量服务器跑 web/api/worker/PostgreSQL/Redis                | 控成本、跑通账本和 Provider PoC            |
| 小规模生产 |   100-500 用户 | web/api/worker 分进程，PostgreSQL/Redis 仍可同机或轻量拆分      | 接 COS/CDN，worker 可水平扩容              |
| 成长阶段   |  500-3000 用户 | API 2+ 实例，worker 独立多实例，PostgreSQL 云 RDS，Redis 云服务 | API 无状态化，队列分组，读写监控           |
| 高并发阶段 |     3000+ 用户 | API/worker 独立集群，读副本，独立 SSE 服务，独立对象存储/CDN    | 分库前评估，冷热数据归档，多 Provider 灰度 |

### 8.2 服务拆分顺序

推荐拆分顺序：

```text
单机 Docker Compose
  -> 独立 worker 进程
  -> 独立 PostgreSQL/RDS
  -> 独立 Redis
  -> API 多实例
  -> SSE 独立服务
  -> Worker 按队列类型拆池
  -> DB 读副本和历史归档
```

拆分说明：

- `web` 可最早静态化或单独部署，但不影响交易安全。
- `api` 必须无状态，session/token 和幂等状态不得存内存。
- `worker` 可以按 `agent/workflow/provider-callback/evaluation/notification` 分队列扩容。
- `provider-callback` 队列优先级高于普通生成队列，避免回执堆积造成 unknown。
- `ledger` 相关任务使用独立低并发队列，禁止被大批生成任务挤占。

### 8.3 队列并发策略

| 队列                | 扩容策略                                 | 保护规则                                   |
| ------------------- | ---------------------------------------- | ------------------------------------------ |
| `agent`             | 按 CPU 和 LLM 限流扩 worker              | 单 turn 循环预算和重复工具调用保护必须启用 |
| `workflow`          | 按任务等待 P95 扩 worker                 | 只推进 DB 状态，不持有内存真相             |
| `task`              | 按 Provider 能力分 model/provider 子队列 | `accepted/outcome_unknown` 不自动重试      |
| `provider-callback` | 高优先级、低延迟处理                     | webhook 入库失败进入 dead letter           |
| `evaluation`        | 可低优先级延迟执行                       | 上架导出前必须完成必要检查                 |
| `notification`      | 可批量、可降级                           | 不影响交易主流程                           |

生成提交和系统执行并发分离：

- 用户已有活动 workflow 不阻断新生成提交；通过交易和风险校验的 task 均可进入队列。
- 系统 Provider 并发按 `03` 模型能力契约配置，例如 `provider/model/concurrency`。
- 当 Provider 并发满时，任务保持排队，不额外占用新费用。

队列控制面默认值：

| 参数                       | 默认值 | 约束                                   |
| -------------------------- | ------ | -------------------------------------- |
| heartbeat interval         | 15 秒  | 必须小于 stale threshold               |
| heartbeat stale threshold  | 45 秒  | 不得小于 heartbeat interval 的 3 倍    |
| dispatcher lease           | 30 秒  | 必须大于 renew interval                |
| dispatcher lease renew     | 10 秒  | 必须小于 lease                         |
| dispatcher poll            | 1 秒   | 不得小于 100ms                         |
| dispatcher batch           | 100    | 正整数且不得无界                       |
| dispatcher backoff base    | 1 秒   | 指数退避加 jitter                      |
| dispatcher backoff maximum | 60 秒  | 不得小于 base                          |
| graceful drain timeout     | 30 秒  | 超时后由恢复机制接管，不延长为无界等待 |

Redis 恢复规则：

- 每个 `REDIS_PREFIX` 使用由 `packages/queue` 代码常量定义的版本化 recovery sentinel；不得通过环境变量任意伪造“已恢复”版本。
- 新 schema/job type 使用两阶段滚动发布。S08 Release A 的 Worker 必须在 heartbeat metadata 报告 `supported_queue_schema_versions=[1,2]`，但保持 v2 Producer 关闭；只有活跃 heartbeat 中已无 v1-only Worker，才能部署提升 `QUEUE_RECOVERY_SCHEMA_VERSION=2` 的 Release B。新 sentinel 未完成时 readiness 503，禁止用配置或人工写 Redis 跳过 reconciliation；历史 v1 intent 不改写。
- sentinel 缺失时，以数据库 session advisory lock 选出唯一 reconciler，分页核对 pending/dispatched intent；session lock 占用专用 ops 连接但不持有跨 Redis 调用的数据库事务，完成全部分页后才写 sentinel。
- reconciliation 中途退出时 sentinel 保持缺失，其他实例可接管；终态 no-op，accepted/polling/outcome_unknown 不重新提交 Provider。
- sentinel 缺失期间 queue control-plane readiness 失败，只读/诊断/恢复可运行，新的生成/收费写操作 fail closed；sentinel 不设 TTL，写入完成后才恢复接流。
- ops 演练只删除唯一测试 prefix 下的 key，禁止在共享或非隔离 Redis 执行 `FLUSHALL`/`FLUSHDB`。
- Worker drain 时先停止新 claim/取 job，但继续续约本实例已领取且仍在处理的 lease；完成最终 CAS 后停止续约。到达 timeout 时先停止续约并放弃后续写入，其他实例只在 lease 真实过期后接管。

### 8.4 数据库扩容

必须优先优化：

- 使用 `05` 的查询模式驱动索引。
- 所有 API 分页，禁止无界列表。
- `event_outbox`、`agent_trace_steps`、`user_activity_logs` 按时间归档。
- 历史产物和 trace 可冷热分层，账本和 reservation 不做破坏性归档。

触发动作：

| 指标                |        阈值建议 | 动作                                  |
| ------------------- | --------------: | ------------------------------------- |
| DB CPU              |      持续 > 60% | 拆 RDS 或升配                         |
| 慢查询              |     P95 > 300ms | 补索引/改查询                         |
| 连接数              | 持续 > 70% 上限 | 加连接池/PgBouncer                    |
| event_outbox 表膨胀 |    查询明显变慢 | 分区或归档 debug/normal 事件          |
| ledger replay 变慢  |    日常对账超时 | 按用户/月份优化索引，不改 ledger 真相 |

连接池建议：

| 进程      | beta 初始 | 说明                             |
| --------- | --------: | -------------------------------- |
| api       |    max 20 | API 连接池使用 DB 上限的主要额度 |
| worker    |     max 5 | Worker 单独连接池，避免抢占 API  |
| migration |     max 1 | 迁移独占执行，不并行             |

部署必须满足：

```text
sum(api_instances * api_pool_max)
+ sum(worker_instances_by_pool * worker_pool_max)
+ migration_connections
+ ops_reserved_connections
<= floor(database_max_connections * 0.8)
```

至少预留 20% 给迁移、管理、故障恢复和瞬时抖动。`DB_OPS_RESERVED_CONNECTIONS` 必须显式配置，beta 初始为 5；扩容副本前先重算预算，不能保持每实例连接池不变地直接加副本。当 DB 连接接近上限时，优先引入 PgBouncer 或拆 RDS，不允许各模块自行放大连接池。引入 PgBouncer 前必须实测 Drizzle/postgres.js 的 prepared statement、事务和 migration 兼容性。

### 8.5 SSE 扩容与降级

SSE 高并发策略：

- beta 阶段由 API 直接提供 SSE。
- 小规模生产可保持 API SSE；多实例使用 Redis pub/sub 做 fanout/wake-up，并按连接的 `last_event_seq` 从 `event_outbox` 补齐。
- 成长阶段可拆 `sse` 独立服务，但 Redis pub/sub 只负责低延迟投影，丢消息不能改变业务真相。
- 若 SSE 连接数超过服务上限，前端降级为轮询 `GET /api/v1/workflow-runs/{id}` 和 `GET /api/v1/tasks`。

降级规则：

- 账本、终态、artifact 创建和 Provider unknown 为 critical 事件，不得丢。
- `turn.message_delta` 可降级或丢弃，只保留摘要。
- 断线恢复仍以 `last_event_seq` 和详情 API 为准。

### 8.6 Provider 和成本扩容

Provider 扩容不是单纯加并发，必须防止成本失控：

- 每个模型配置 `rpm/concurrency/daily_budget/hourly_budget`。
- 新 Provider 必须先通过 `03` PoC 和成本工作表。
- 同一 Skill 可分别发布多个模型作为用户可选项；单个 turn 创建后必须冻结模型、通道、凭据和 pricing_version，不得在 turn 内自动切换或回退到其他模型。
- 高峰期优先排队，不静默切换到更贵模型。
- Provider 成本异常时，先熔断高成本模型，再暂停高风险 Skill。

### 8.7 应急容量开关

运营后台必须预留：

- 暂停新生成任务。
- 降低 Provider/model 实际执行并发。
- 暂停高成本 Skill。
- 熔断单 Provider/模型。
- 关闭注册赠送和邀请奖励。
- 关闭非必要 `turn.message_delta` 流式输出。
- 只允许查看历史和下载已完成产物。

## 9. 测试与代码规范

Bootstrap 必须同步建立测试和代码规范：

| 项                   | 选择                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| TypeScript           | `strict: true`，核心 package 不允许隐式 any                           |
| 单元测试             | Vitest                                                                |
| 前端组件测试         | Vitest + Testing Library                                              |
| API 集成测试         | Vitest + Supertest                                                    |
| 浏览器 E2E/UI        | Playwright                                                            |
| API/e2e              | 基于真实 API 的 validation 脚本                                       |
| 队列/Worker 集成测试 | Vitest + Redis/BullMQ 测试环境                                        |
| 压测/并发            | k6；本地安装困难时可用 Artillery 作为等价替代                         |
| Lint                 | ESLint                                                                |
| Format               | Prettier                                                              |
| Git Hooks            | Husky + lint-staged + commitlint，S01 强制交付                        |
| 提交规范             | Conventional Commits；Commitizen + cz-git 提供 `pnpm commit` 辅助入口 |

### 9.1 Git、运行时和包管理锁定

- S01 第一条工程命令必须是 `git init`。确认 `.git/` 存在后才能安装 Husky、执行 `prepare` 或创建 `.husky/*`；禁止在无 Git 仓库时忽略 Husky 安装错误继续开发。
- 根 `package.json` 使用 `engines.node: >=22.22 <23`，并通过 `.nvmrc` 和 `.node-version` 固定 `22.22.3`。
- 使用 Corepack 管理 pnpm，根 `package.json` 固定 `packageManager: pnpm@11.7.0`；后续不得个人自行升级。
- 必须提交 `pnpm-lock.yaml`，CI 使用 `pnpm install --frozen-lockfile`。
- 根目录提供 `.editorconfig` 和 `.gitattributes`；文本统一 UTF-8、2 空格、LF、文件末尾换行。Husky 脚本必须保持 LF，避免 Windows/Linux 混用失效。
- 禁止混用 npm/yarn lockfile；依赖升级必须单独提交并通过完整检查。

### 9.1.1 pnpm workspace 结构

`pnpm-workspace.yaml` 只收录两类 workspace：

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

- `apps/web`、`apps/api`、`apps/worker` 是可独立启动和部署的应用，不被其他 workspace 反向依赖。
- `packages/*` 是不可独立部署的复用包，统一命名为 `@ecom-forge/<name>`。
- 内部包依赖必须写 `workspace:*`，禁止发布前偷偷解析 npm 同名包。
- 根 package 设为 `private: true`，只放 Turbo、质量工具、统一脚本和共享开发依赖，不放业务源码。
- `packages/types/shared` 保持底层无副作用；`agent/compiler/credit/provider/queue/db/skills` 按 `§3` 边界依赖，禁止循环依赖。
- Turbo 负责编排 `dev/build/lint/typecheck/test`，pnpm 负责 workspace 和依赖锁；不使用 npm workspaces 或第二套任务编排器。

### 9.2 ESLint 和 Prettier

配置文件固定为根目录 `eslint.config.mjs`、`prettier.config.mjs`、`.prettierignore`：

- ESLint 使用 flat config，并对 TypeScript 启用类型感知规则。
- 基础强制规则至少包括：未处理 Promise、误用 Promise、一致 type import、无未使用变量、禁止隐式 any。
- `packages/credit`、`packages/compiler`、`packages/agent`、`packages/provider` 禁止显式 `any`；确需未知输入使用 `unknown` + schema 校验。
- 使用 `no-restricted-imports` 或等价边界规则：`apps/web` 不得导入 DB/Credit/Provider 内部实现；业务 package 不得反向依赖 apps；`packages/shared/types` 不得依赖有副作用模块。
- Prettier 统一：2 空格、单引号、分号、尾逗号、`printWidth: 100`、`endOfLine: lf`。
- 生成目录、构建产物、覆盖率、Playwright 报告、二进制资产和生成 migration SQL 必须进入 ignore，不做自动格式化。

根命令必须存在：

```text
pnpm format
pnpm format:check
pnpm lint
pnpm lint:fix
pnpm typecheck
pnpm check
```

`pnpm check` 至少执行 `format:check -> lint -> typecheck -> test`；CI 另追加 build、集成测试和阶段 validation。

### 9.3 Git 提交门禁

Husky 必须提供：

```text
.husky/pre-commit  -> pnpm exec lint-staged --max-arg-length 4096
.husky/commit-msg -> pnpm exec commitlint --edit "$1"
```

`lint-staged` 只处理已暂存文件：

```text
*.{ts,tsx,js,mjs,cjs}          -> eslint --fix -> prettier --write
*.{json,jsonc,yml,yaml,md,css,scss} -> prettier --write
```

规则：

- pre-commit 不运行全量 typecheck/test/build，避免 Hook 过慢；这些检查由 `pnpm check` 和 CI 负责。
- lint-staged 固定以 4096 字符上限分批，给 Windows cmd 的路径转义和 shim 参数保留余量；分批不得改变文件匹配、检查内容或失败阻断规则。
- 自动修复后的文件必须重新加入暂存区；未修复的 lint error 阻止提交。
- `--no-verify` 不能作为合并依据，CI 必须重新执行全部门禁。
- commitlint 使用 `@commitlint/config-conventional`。允许类型：`feat/fix/refactor/perf/test/docs/build/ci/chore/revert`。
- scope 使用模块名：`web/api/worker/db/agent/compiler/credit/provider/queue/skills/docs`；提交标题必须有实际内容，header 最长 100 字符。
- Commitizen 只提供交互辅助，不承担强制校验；`pnpm commit` 使用 `commitizen + cz-git`，最终仍由 commitlint 裁决。

覆盖率门槛：

- `credit`、`workflow`、`agent compiler` 核心模块单元测试覆盖率不低于 70%。
- 资金路径必须有集成测试，不接受只靠 mock。
- `pnpm test`、`pnpm test:integration`、`pnpm test:worker`、`pnpm test:e2e`、`pnpm typecheck` 必须在 staging 发布前通过。

并发和压力测试：

- 阶段 0 至少提供 `pnpm test:load -- --concurrent 50` 或同等脚本。
- 压测必须覆盖：创建 turn、提交 quote、SSE 连接、worker 消费、Provider fake 延迟。
- 压测不允许调用真实付费 Provider，除非使用封闭 PoC 预算。

## 10. 数据库变更 SOP

迁移原则：

1. 只允许向前兼容迁移：新增表、字段、索引、枚举值；删除和重命名必须拆成多版本灰度。
2. 生产迁移前必须在 staging 跑通。
3. 生产迁移前必须备份数据库。
4. 迁移失败时优先回退代码版本；迁移 SQL 不强制自动回滚，避免二次破坏。
5. 必须提供 `pnpm db:migrate:dry-run` 或同等 SQL 预览。
6. 账本、reservation、workflow、task 表的迁移必须有专项验收查询。

上线顺序：

```text
备份数据库
  -> staging dry-run
  -> production dry-run
  -> 执行向前兼容 migration
  -> 发布兼容新旧 schema 的代码
  -> 验证核心 API/ledger replay
  -> 后续版本清理旧字段
```

## 11. 监控、日志与告警工具

beta 推荐低成本组合：

| 能力      | beta 推荐                                                        |
| --------- | ---------------------------------------------------------------- |
| 应用日志  | 文件日志 + logrotate，后续接腾讯云 CLS                           |
| 指标      | Prometheus + Grafana 或轻量自建指标接口                          |
| 告警      | 企业微信机器人或钉钉机器人 Webhook                               |
| APM/Trace | 阶段 0 先用 `agent_traces` 和结构化日志；1B 后评估 OpenTelemetry |

告警渠道：

- `ALERT_WEBHOOK_URL` 默认指向企业微信或钉钉机器人。
- critical 告警包括账本不一致、Provider unknown 激增、单小时成本超预算、worker heartbeat 丢失。
- 告警必须包含环境、模块、trace/run/task ID 和处理建议。

CI/CD：

- beta 前可以手工发布，但必须保留发布 checklist；代码合并仍需通过 CI 或在无远端 CI 时留存 `pnpm check` 执行记录。
- S01 建立 GitHub Actions、GitLab CI、Gitee 流水线或等价 CI 基线：`install --frozen-lockfile -> format:check -> lint -> typecheck -> test -> build`。
- 涉及 DB、Worker、资金、Provider 或发布的变更追加对应 integration、worker、migration 和 validation job。
- 分支保护以 CI 为最终门禁，本地 Husky 不能替代 CI。

## 12. 合规与域名上线要求

面向中国用户公开访问时：

- 使用大陆服务器、大陆 CDN 或大陆对象存储加速域名时，production 域名必须完成 ICP 备案；备案周期通常需提前规划。
- 服务器、域名、证书和对象存储域名必须符合备案和云厂商要求。
- HTTPS 必须启用。
- 若启用公开分享、付费、用户内容分发，必须复核 `08` 的法务门禁。
- 是否需要等保 2.0、算法/深度合成相关备案或测评，由法务/合规在公开上线前裁决。

## 13. 欧美海外部署备选

欧美海外方案只作为备选；中国香港 Beta 方案按 §6 裁决，不归入本节。

| 服务                  | 定位                                                       |
| --------------------- | ---------------------------------------------------------- |
| Vercel                | 海外前端部署和边缘体验                                     |
| Railway/Render/Fly.io | 海外 NestJS API/Worker 部署                                |
| Neon                  | 海外 PostgreSQL                                            |
| Vercel Blob/S3        | 海外对象存储                                               |
| Vercel AI SDK         | Brain 的内部协议调用层；不作为模型网关或统一 Provider 路由 |

约束：

- 面向中国用户的默认链路不得依赖欧美海外托管服务；中国香港 Beta 例外按 §6 执行。
- 若使用海外模型，必须经过 `03` Provider PoC，验证延迟、可用性、成本和合规。
- 海外部署价格和时长限制不得作为国内上线预算依据。

## 14. 环境变量分组

本节的变量清单是 typed config 的输入边界，不是要求把所有变量复制进 `.env`。原则固定为：

- 只有部署时会变化、且不能安全写进代码的值才进入环境注入：环境标识、数据库/Redis 连接、公开 Origin/代理 CIDR、Provider relay allowlist、邮件 Provider 连接和所有 secret/keyring。
- 队列参数、SSE 参数、Agent 上限、存储限制、限流、超时、默认端口和本地 loopback 地址由 `apps/api/src/config/runtime-defaults.ts`、`apps/worker/src/config/runtime-defaults.ts` 及 typed loader 管理，不写入 `.env.local`。
- API 与 Worker 不共享进程职责开关。`PROVIDER_PROCESSOR_MODE` 只允许注入 Worker 进程；本地 `apps/worker/scripts/dev.mjs` 固定使用真实消费，API 不读取该变量。生产 Worker 显式注入 `PROVIDER_PROCESSOR_MODE=real`，API 不注入它。
- `TEST_*` 只由测试 runner 临时注入；本地业务 `.env.local` 不保存测试数据库、测试 Redis、PoC 次数或 fake Provider 开关。
- `.env.local` 是本机运行输入，不是部署模板；`.env.example` 只保留部署输入占位符。修改固定策略时改代码配置和测试，不在环境文件里复制一遍。

Agent 输出策略（2026-10-03）：typed default 单次 8192；累计额度按当前附件、已鉴权历史候选和计划节点的工作量分配，不假定模型用满四调用批次。默认单图 6 轮/49152、4 图 12 轮/98304、9 图 22 轮/180224；工具额度分别为 12/15/20。运营累计 ceiling 为 360448，不是每次都分配此数。`AGENT_MAX_OUTPUT_TOKENS` 可收紧累计 ceiling，`AGENT_BRAIN_STEP_MAX_OUTPUT_TOKENS` 可收紧单次额度；均不是提示词长度要求。272000 上下文窗口、217600 自动压缩、默认 0.15 CNY/turn 独立成本门禁保留。升级后使用稳定 Worker 进程重启，不开 watch 或第二个 Worker；验收同时检查 trace 中实际 requested output、usage、截断类别及逐节点 checkpoint。

| 分组     | 变量                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App      | `NODE_ENV`、`APP_ENV`、`WEB_ORIGIN`、`API_INTERNAL_ORIGIN`、`NEXT_PUBLIC_API_ORIGIN`、`API_PORT`、`AUTH_TRUSTED_ORIGINS`、`TRUSTED_PROXY_CIDRS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Database | `DATABASE_URL`、`DB_POOL_MAX`、`DB_STATEMENT_TIMEOUT_MS`、`DB_TRANSACTION_TIMEOUT_MS`、`DB_OPS_RESERVED_CONNECTIONS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Redis    | `REDIS_URL`、`REDIS_PREFIX`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Queue    | `WORKER_HEARTBEAT_INTERVAL_MS`、`WORKER_HEARTBEAT_STALE_MS`、`QUEUE_DISPATCH_LEASE_MS`、`QUEUE_DISPATCH_LEASE_RENEW_MS`、`QUEUE_DISPATCH_POLL_MS`、`QUEUE_DISPATCH_BATCH_SIZE`、`QUEUE_DISPATCH_BACKOFF_BASE_MS`、`QUEUE_DISPATCH_BACKOFF_MAX_MS`、`WORKER_DRAIN_TIMEOUT_MS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Agent    | `AGENT_BRAIN_ADAPTER`、`AGENT_REQUEST_TIMEOUT_MS`、`AGENT_PROCESSING_LEASE_MS`、`AGENT_PROCESSING_RENEW_MS`、`AGENT_MAX_LLM_ROUNDS`、`AGENT_MAX_TOOL_CALLS`、`AGENT_MAX_INPUT_TOKENS`、`AGENT_MAX_OUTPUT_TOKENS`、`AGENT_BRAIN_STEP_MAX_OUTPUT_TOKENS`、`AGENT_MAX_ESTIMATED_COST_CNY`、`AGENT_MAX_REFERENCES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SSE      | `SSE_HEARTBEAT_INTERVAL_MS`、`NEXT_PUBLIC_SSE_WATCHDOG_TIMEOUT_MS`、`SSE_REPLAY_BATCH_SIZE`、`SSE_BACKPRESSURE_TIMEOUT_MS`、`SSE_MAX_CONNECTIONS`、`SSE_MAX_CONNECTIONS_PER_USER`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Test     | `TEST_DATABASE_URL`、`TEST_REDIS_URL`、`TEST_REDIS_PREFIX`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Storage  | local/test：`STORAGE_DRIVER`、`LOCAL_UPLOAD_ROOT`；S14 secret plane：`STORAGE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID/KEYRING`、`STORAGE_CREDENTIAL_HINT_ACTIVE_KEY_ID/KEYRING`、`STORAGE_CAPABILITY_SECRET`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Provider | `PROVIDER_MODE`、`PROVIDER_PROCESSOR_MODE`、`PROVIDER_ADAPTER`、`PROVIDER_RELAY_ORIGINS`、`PROVIDER_IMAGE_OUTPUT_ORIGINS`、`PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID/KEYRING`、`PROVIDER_CREDENTIAL_HINT_ACTIVE_KEY_ID/KEYRING`、厂商命名空间 `PROVIDER_*_API_KEY` / `PROVIDER_*_WEBHOOK_SECRET`、`PROVIDER_CALLBACK_DIGEST_KEYRING`、`PROVIDER_CALLBACK_DIGEST_ACTIVE_KEY_ID`、`PROVIDER_ENDPOINT`、`PROVIDER_REGION`、`PROVIDER_CONNECT_TIMEOUT_MS`、`PROVIDER_REQUEST_TIMEOUT_MS`、`IMAGE_PROVIDER_REQUEST_TIMEOUT_MS`、`PROVIDER_POLL_INTERVAL_MS`、`PROVIDER_TERMINAL_TIMEOUT_MS`、`PROVIDER_WEBHOOK_MAX_BODY_BYTES`、`PROVIDER_WEBHOOK_CLOCK_SKEW_SECONDS`、`POC_CONFIRM_REAL_COST`、`POC_MAX_CALLS`                                                                        |
| Auth     | `AUTH_SECRET`、`AUTH_OTP_HASH_SECRET`、`AUTH_RATE_LIMIT_SECRET`、`AUTH_VERIFICATION_TICKET_SECRET`、`AUTH_OTP_*_LIMIT`、`AUTH_OTP_COOLDOWN_SECONDS`、`AUTH_INVITE_TEN_MINUTE_LIMIT`、`AUTH_VERIFY_*_LIMIT`、`AUTH_LOGIN_*_LIMIT`、`AUTH_PASSWORD_RESET_RESPONSE_FLOOR_MS`、`AUTH_INVITE_CODE_ACTIVE_KEY_ID`、`AUTH_INVITE_CODE_KEYRING`、`AUTH_REWARD_FINGERPRINT_ACTIVE_KEY_ID`、`AUTH_REWARD_FINGERPRINT_KEYRING`、`TRUSTED_PROXY_CIDRS`                                                                                                                                                                                                                                                                                                                                            |
| Admin    | `ADMIN_ORIGIN`、`ADMIN_ALLOWED_HOSTS`、`TRUSTED_ADMIN_PROXY_CIDRS`、`ADMIN_NETWORK_GATE_MODE`、`ADMIN_SOURCE_ALLOWLIST_CIDRS`、`ADMIN_COOKIE_SECURE`、`ADMIN_IDENTIFIER_HASH_ACTIVE_KEY_ID/KEYRING`、`ADMIN_SESSION_HASH_ACTIVE_KEY_ID/KEYRING`、`ADMIN_CSRF_DERIVATION_ACTIVE_KEY_ID/KEYRING`、`ADMIN_CHALLENGE_HASH_ACTIVE_KEY_ID/KEYRING`、`ADMIN_ENROLLMENT_HASH_ACTIVE_KEY_ID/KEYRING`、`ADMIN_IDEMPOTENCY_HASH_ACTIVE_KEY_ID/KEYRING`、`ADMIN_RECOVERY_HASH_ACTIVE_KEY_ID/KEYRING`、`ADMIN_SOURCE_HASH_ACTIVE_KEY_ID/KEYRING`、`ADMIN_TOTP_ENCRYPTION_ACTIVE_KEY_ID/KEYRING`、`ADMIN_SESSION_TTL_SECONDS`、`ADMIN_SESSION_IDLE_TTL_SECONDS`、`ADMIN_CHALLENGE_TTL_SECONDS`、`ADMIN_STEP_UP_TTL_SECONDS`、`ADMIN_ENROLLMENT_TTL_SECONDS`、`ADMIN_ARGON2_*`、`ADMIN_AUTH_*_LIMIT` |
| Mail     | `MAIL_PROVIDER`、`MAIL_FROM`、`MAIL_FROM_NAME`、`MAIL_SMTP_HOST`、`MAIL_SMTP_PORT`、`MAIL_RECOVERY_STALE_SECONDS`、`MAIL_SMTP_SECURE`、`MAIL_TENCENT_SECRET_ID`、`MAIL_TENCENT_SECRET_KEY`、`MAIL_TENCENT_REGION`、`MAIL_TENCENT_ENDPOINT`、`MAIL_TENCENT_TEMPLATE_ID_VERIFY`、`MAIL_TENCENT_TEMPLATE_ID_RESET`、`MAIL_WEBHOOK_SECRET`、`MAIL_RECIPIENT_HASH_ACTIVE_KEY_ID`、`MAIL_RECIPIENT_HASH_KEYRING`                                                                                                                                                                                                                                                                                                                                                                            |
| Ops      | `ALERT_WEBHOOK_URL`、`COST_BUDGET_HOURLY`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

规则：

- `.env.example` 只能放占位，不放真实密钥。
- beta/production 密钥必须隔离。
- `ADMIN_*` 只由 typed config loader 读取。local 的 `ADMIN_ALLOWED_HOSTS` 默认同时允许 Admin 浏览器入口 `:3002` 与 Next.js 内部 API 代理 `:3001` 的 loopback Host；自定义本地端口时必须同步列出两者。staging/beta/production 要求 `ADMIN_COOKIE_SECURE=true`、独立 Admin Origin/Host、非空 `TRUSTED_ADMIN_PROXY_CIDRS`，并且 `ADMIN_NETWORK_GATE_MODE` 只能是已配置的 `identity_gateway | vpn | source_allowlist`；local/test 才允许 loopback。任一 keyring 缺 active key、复用普通 Auth secret、Host/Origin/CIDR 拓扑不匹配或外围入口未配置时，Admin readiness fail closed。
- S14 激活版本化 `reward_campaigns` 后移除 `REGISTRATION_REWARD_ENABLED/CAMPAIGN/AMOUNT` 的运行时裁决；不得同时保留环境开关和数据库活动两套授权真相。迁移期只允许一次性读取 legacy 值创建 draft，由管理员复核后发布，不能自动激活。
- Provider Key 不进入前端环境变量。
- `COS_SECRET_ID/COS_SECRET_KEY/COS_BUCKET/COS_REGION/COS_ENDPOINT` 只允许作为 S15 上线前受控一次性迁移输入，不再作为 staging/beta/production 运行时配置。生产存储从 `storage_runtime_state` 解析已审批 channel，并由窄 secret repository 解密 active credential；迁移输入不得写日志、命令行或长期 `.env`，创建 draft 后必须移除并由固定 probe/管理员审批激活。S14A 本地验收不开放生产存储，S15 腾讯 COS adapter 与真实 smoke 通过前 readiness fail closed。
- Agent Brain Key、model ID、endpoint、预算和 Tool registry 不进入 `NEXT_PUBLIC_*`、HTTP header/query、queue payload 或创作平台本地配置；最终配置/审批只来自独立 `apps/admin` 控制面和受控 secret。
- Provider endpoint、region 和 adapter 必须来自 typed allowlist，禁止通过数据库、管理请求或 queue payload 注入任意 URL/header/body。test 只允许 fake；local Worker 可使用真实 Provider 做验收，但必须沿用生产同一套 typed config、密钥隔离和 Provider 三态处理；staging/beta/production 的 route 必须通过 S07/S14/S15 门禁。
- Web、API、Worker 和 migration 进程只注入各自最小变量集；migration 不接收邮件、Provider 或对象存储密钥。
- Queue 参数由 Worker typed config 统一读取；`heartbeat < stale`、`renew < lease`、`backoff base <= max` 等关系不满足时启动失败，业务代码不得散落读取环境变量。
- 图片生成/编辑传输超时由 Worker typed config 的 `IMAGE_PROVIDER_REQUEST_TIMEOUT_MS` 独立控制，默认 600000ms 且不得超过 600000ms，以覆盖 4K 等慢速图片任务；`PROVIDER_REQUEST_TIMEOUT_MS` 继续用于审核、探针等短请求，禁止为适配慢速生图而整体放宽。
- Agent 参数由 Worker typed config 统一读取；`request_timeout < processing_lease`、`renew * 3 < lease`，且所有预算不超过 S08 硬上限。test 发现真实 adapter/network，非 test 发现 fake tool，staging/beta/production 缺 S14 已审批 model/Key/预算时启动或 Agent readiness 失败。
- SSE 参数由 API typed config 统一读取；`watchdog >= heartbeat * 3`、单用户连接上限不大于实例总连接上限等关系不满足时启动失败。Web 端 watchdog/退避常量必须与 `06`/S06 契约一致，不读取 Redis 或服务器 secret。
- `TEST_*` 只注入 `APP_ENV=test` 的测试 runner：测试 database 必须与 `DATABASE_URL` 不同且名称带 `_test` 边界；Redis 使用独立实例/逻辑 DB 和每次运行唯一 prefix。local/staging/beta/production 业务进程不得读取 `TEST_*`。
- OTP、ticket、限流、邀请码、奖励邮箱族、邮件收件人摘要和 Better Auth secret 必须分域，keyring 只存服务器 secret，数据库只保存非敏感 key ID。
- `fake` 邮件只允许 `APP_ENV=test`；console/smtp 只允许 local；staging/beta/production 只允许真实适配器。
- staging/beta/production 出现默认 secret、local storage、空密钥、任意代理信任、不在 registry 的 endpoint/region/bucket，或缺少 active/validated private storage channel 时启动/readiness 失败。
- 数据库 migration 进程不接收 Agent Brain/Skill cache secret。S08 schema 变更只通过 Drizzle schema 生成新的前向 migration；不得手写 SQL、修改历史 migration、drop/reset/recreate 数据库。
- S08 的 legacy Skill hydration 只能由受控 ops 脚本读取本机不可变发布包，并按 `id + content_hash + content_text is null` CAS 回填；正文不得进入 argv、日志或普通审计。缺包/hash 冲突时发布失败，禁止自动删行或覆盖。
- Skill 安装 CLI/API 只接受本地文件/stdin 或已上传 package artifact ID；禁止远程 URL、Git token 和任意服务器路径。生产安装、审批和 active release 切换归独立 `apps/admin` / S14，创作端与 Worker 无安装权限。

## 15. Bootstrap 验收

创建代码工程后，阶段 0 Bootstrap 至少通过：

- `pnpm install` 成功。
- `docker compose up -d` 启动 PostgreSQL 和 Redis。
- `pnpm db:migrate` 成功。
- `pnpm dev` 同时启动 web、api、worker。
- `pnpm typecheck`、`pnpm lint`、`pnpm test` 成功。
- `GET /api/v1/health` 返回正常。
- `GET /api/v1/health/live` 可用于进程存活探针；`GET /api/v1/health/ready` 在 DB/Redis/recovery sentinel 未就绪时返回 503，发布切流只看 ready。
- worker heartbeat 入库。
- SSE heartbeat 可连接并断线恢复。
- fake Provider 跑通 `run_quote -> reservation -> workflow_run -> task -> artifact`。
- `pnpm validate:stage0` 可执行，即使初期部分用 fake Provider。
- typed config 对缺失/非法 `APP_ENV`、错误邮件适配器、默认 secret、代理 CIDR 和 endpoint 白名单执行启动失败测试。
- S03 本地可用 console/FakeMailAdapter 完成注册与重置全链路；真实邮件 smoke 是 staging/beta 上线门禁，不是 local 编码门禁。

## 16. 与其他文档的边界

| 文档 | 关系                                                                       |
| ---- | -------------------------------------------------------------------------- |
| `01` | 定交易、Provider 回执和产物归属，不由本文改写                              |
| `02` | 定 Agent/Skill 契约，本文只规定 Skill 文件所在工程位置                     |
| `03` | 定 Provider PoC 和成本，本文只规定接入位置和部署偏好                       |
| `04` | 定状态机和 outcome_unknown，本文只规定 worker/cron 执行位置                |
| `05` | 定表结构和索引，本文只规定 DB package 归属                                 |
| `06` | 定 API、SSE、队列 payload，本文只规定服务边界                              |
| `08` | 定安全、法务和合规门禁；香港 Beta 与大陆 production 的合规要求以 `08` 为准 |
| `09` | 定验证和运营，本文定工程部署拓扑，`09` 引用本文                            |
