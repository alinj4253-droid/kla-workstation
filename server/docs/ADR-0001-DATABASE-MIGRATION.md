# ADR-0001：数据库迁移采用文件式单一来源

- 状态：已接受（2026-09-30）
- 关联：主计划 §5 合并规则（"数据库迁移必须向前兼容，禁止直接修改已发布迁移"）、`DATABASE-SETUP.md`

## 背景

仓库中曾并存两套迁移载体：

1. `server/src/database/migrations.ts`：代码内嵌迁移（0004–0006），由 `PostgresDatabase.migrate()` 在服务启动时执行，`schema_migrations` 表记账，`pnpm --filter @kla-workstation/server db:migrate` 提供手动入口。
2. `server/migrations/*.sql`：早期占位草稿（001/002），表结构停留在适配器接线之前（text 主键、`user_accounts`/`organization_members` 等表名），与已上线实现已发生分叉，且无任何代码引用，已删除。

收敛过程中评估了两个方向：保留内嵌、改为文件式。团队即将进入 4–5 人并行开发（E/G/I 组都会高频新增表），最终选择**文件式**。

## 决策

1. `server/migrations/` 是**唯一**迁移来源：一个迁移一个 `.sql` 文件，命名 `NNNN_描述.sql`（至少四位编号，如 `0004_identity_organizations.sql`），按文件名排序执行。
2. `src/database/migrations.ts` 保留为**加载器**：`loadMigrationFiles()` 读取目录、校验命名与重复编号；`runMigrations(pool, schema)` 维持原签名，逐文件事务执行并写入 `schema_migrations` 记账。`postgres.ts`、`server.ts`、`migrate-cli.ts` 无需感知载体变化。
3. 执行方式维持两个入口：
   - 服务启动时自动执行（`server.ts` → `PostgresDatabase.migrate()`，迁移成功后才注册路由）；
   - 手动执行：`pnpm --filter @kla-workstation/server db:migrate`。
4. 迁移在 `DATABASE_SCHEMA`（默认 `kla`）专属 schema 内执行，应用账号不需要 `public` schema 建表权限。

## 理由

- **并行零冲突**：每人在 `migrations/` 下新增自己的文件即可合入，不再向同一数组尾部追加，消除多后端并行开发的高频 merge 冲突。
- **SQL 可读性**：`.sql` 文件有语法高亮、格式化与清晰 diff，便于评审与 DBA 抽查。
- **记账表不变**：`schema_migrations` 与事务/幂等逻辑原样保留，已上线的数据库不需要任何处理。
- **切换成本可控**：内嵌 SQL 原样搬移为编号文件，无语义改动。

## 曾评估的备选：保留代码内嵌

内嵌在迁移数量少时依赖最少、与代码同 PR 评审；但 SQL 失去高亮与静态校验，且多人向同一文件追加必然产生冲突。若未来需要程序化迁移（如数据回填依赖 TS 逻辑），可扩展加载器支持 `.ts` 迁移文件，不影响本决策。

## 影响

- 已应用的迁移（`schema_migrations` 中有记录的）**禁止修改**；修正错误一律新增文件向前修复，不提供 down 迁移。
- 新增迁移：在 `server/migrations/` 新建 `NNNN_描述.sql`（编号递增），语句保持幂等（`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`），全新库与已迁移库都必须能执行成功。
- 构建产物 `dist/` 通过相对路径（`../../migrations/`）定位迁移目录，`start`（`node dist/server.js`）与源码运行行为一致。
