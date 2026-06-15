# Runbook · A' 一次性数据迁移(老会话各成单对话项目)

> 状态:**✅ 已完结**(2026-06-15 由**老板**手动执行:dry-run + apply 确认**当前生产账号无老数据可迁**
> —— `migrated:0`、no-op,机制验证 OK)。PR-D(#85)已收口清债:删 `POST /api/admin/migrate-projects`
> 端点 + `migrateProjects.ts` + 两个测试,并新 migration `0008_drop_migrate_backup.sql` DROP 空备份表。
> 本 runbook 留作历史记录,不再执行。

把老 `chat_sessions` 数据迁到 A'「项目 ↔ 对话」模型(背景 + 策略见
[`docs/refactor-project-conversation.md` §2.3](../../docs/refactor-project-conversation.md))。**需 JS**
(要 parse `turns_json`、按 sentinel id 抽 #76 工作区快照),纯 SQL 干不了,故走一个 **owner-only +
owner-scoped 一次性维护端点**:

```
POST /api/admin/migrate-projects
  body { mode: "dry-run" | "apply" | "rollback", confirm?: "MIGRATE-A-PROJECTS" }
```

逻辑在 [`workers/src/migrateProjects.ts`](../src/migrateProjects.ts),被 vitest 直接覆盖
(`migrate-projects-unit.test.ts` + `migrate-projects-api.test.ts`)。

**这个端点干什么**(对调用 owner 自己 `project_id IS NULL` 的每行老会话):

1. mint 一个服务端 UUID `project_id`;
2. 从 `turns_json` 抽出快照 turn(`id = __agentaily_workspace_snapshot__`、`kind = workspace`)的
   `{meta, fields}` → 写进新 `projects` 行(`meta_json`/`fields_json`);老 `form_slug` 上移到
   `projects.form_slug`;`created_at`/`updated_at` 沿用该会话;
3. 回填会话 `project_id`、**从 `turns_json` 删掉那条快照 turn**;`title` 留 NULL(运行期推导);
4. 没快照的老行 → 同样 mint project,工作区留空(`meta_json`/`fields_json` NULL)。

### 铁律(已内建,执行时心里有数)

- **幂等**:只处理 `project_id IS NULL` 的行;写时 UPDATE 再带 `AND project_id IS NULL`。重跑只碰
  还没迁的行,已迁的不重抽。
- **owner-scoped**:端点只迁**调用者自己**的行(`WHERE owner_id = 你的 user id`)。生产现是单 owner
  (`yarnb@qq.com`),登录它跑一次即覆盖全部。**若将来有多个 owner**,每个 owner 各登录跑一次。
- **先备份**:apply 时先把受影响行的 pristine 原值(`turns_json` / `form_slug` / mint 的
  `project_id`)写进库内备份表 `chat_sessions_a_backup`,`rollback` 可精准还原。**库外再叠一层
  `wrangler d1 export` 全量兜底**(第 1 步,强制)。
- **不可逆**:删快照 turn 是有损写。靠先备份 + 幂等兜。

### ⚠️ 卡窗口(执行时机)

本迁移 apply 生产后,**旧前端读到「已抽走快照」的会话会没工作区**。故 apply 要**紧接 PR-C 前端切换
前后**(PR-C 把前端切到项目级工作区,从 `projects` 读、不再读 `turns_json` 快照)。理想顺序:
**PR-A(#81,已合)→ 部署后端含本端点 → PR-C 前端就绪 → 本迁移 apply → PR-C 上线**,把「旧前端 +
已迁数据」的空窗压到最小。具体先后由老板拍。

---

## 执行步骤

前置:PR-B 已合并到 `main` 且 `deploy-workers.yml` 已把含 `POST /api/admin/migrate-projects` 的
后端部署上生产(`d1 migrations apply` 早在 PR-A 已建好 `projects` 表 + 列)。

### 0. 取一个登录态 token(承接历史数据的 owner)

```bash
TOKEN=$(curl -s -X POST https://form-design-api.agentaily.workers.dev/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"你的邮箱","password":"你的密码"}' | jq -r .token)
echo "${TOKEN:0:12}…"   # 非空即可
```

### 1. 备份(强制,先做)

全量导出 D1(真正的回滚兜底):

```bash
cd workers
npx wrangler d1 export form-design-db --remote --output "backup-pre-0007-$(date +%Y%m%d-%H%M%S).sql"
```

> 把导出文件收好(别提交进仓)。库内备份表是 apply 时自动写的、用于 `rollback` 端点精准还原;这份
> 全量导出是「连库一起翻车」时的最终兜底,两层都要。

### 2. Dry-run(只读,看清要动多少、抽得对不对)

```bash
curl -s -X POST https://form-design-api.agentaily.workers.dev/api/admin/migrate-projects \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"dry-run"}' | jq
```

报告字段:`migrated`(会迁多少行)、`withSnapshot` / `withoutSnapshot`(有/无快照各几行)、
`samples[]`(前若干条:`sessionId` / `projectId`(**示意值**——dry-run 每跑一次都另 mint,apply 时
会重新 mint、**不复用**这里看到的 id)/ `hadSnapshot` / `fieldCount` / `title`)。**肉眼核对** samples
的 `title` / `fieldCount` 跟你印象里的表单对得上。dry-run **零写**。

### 3. Apply(不可逆 · 老板拍板后才跑)

```bash
curl -s -X POST https://form-design-api.agentaily.workers.dev/api/admin/migrate-projects \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"apply","confirm":"MIGRATE-A-PROJECTS"}' | jq
```

成功 → `mode:"apply"`、`migrated:N`、`backedUp:N`(= 写进备份表的行数)。

### 4. 验证

- 再跑一次 **dry-run** → `migrated:0`(幂等:已全迁,无候选)。
- 抽查一行:
  ```bash
  npx wrangler d1 execute form-design-db --remote --json --command \
    "SELECT session_id, project_id, length(turns_json) FROM chat_sessions LIMIT 5"
  npx wrangler d1 execute form-design-db --remote --json --command \
    "SELECT project_id, meta_json IS NOT NULL AS has_meta, form_slug FROM projects LIMIT 5"
  ```
  每行老会话都有了 `project_id`;`projects` 里出现对应行;原带快照的会话 `turns_json` 里不再有
  `__agentaily_workspace_snapshot__`。
- (PR-C 上线后)前端登录 → 进项目工作区应恢复原表单 meta/fields、对话照常。

### 5. 回滚(出问题时)

**精准回滚**(从库内备份表逐字还原 `turns_json`、置回 `project_id`、删 mint 的项目):

```bash
curl -s -X POST https://form-design-api.agentaily.workers.dev/api/admin/migrate-projects \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"rollback","confirm":"MIGRATE-A-PROJECTS"}' | jq   # → restored:N
```

> ⚠️ **精准回滚只在「项目尚未被使用」的紧窗口内安全。** 它**盲目**把 `turns_json` 倒回旧值、删掉
> mint 的项目——若此时 PR-C 已上线、owner 已在那个项目里编辑过工作区 / 新开过对话,这些**迁移后
> 的新数据会被静默丢弃**。所以:apply 后**马上发现不对**→ 精准回滚安全;**已经用了一段**(PR-C 上线
> 且动过项目)→ **别用精准回滚**,改用下面的全量回滚按 §7 处理。

**全量回滚**(连库翻车 / 备份表也丢了 / 已过精准回滚安全窗 → 用第 1 步的导出):见
[RELEASE.md §7 回滚](../../RELEASE.md)。

---

## 收口(PR-D · ✅ 已完结,#85)

A' 重构第 4 根(PR-D / #85)已收口清债:① 删 `POST /api/admin/migrate-projects` 端点 +
`migrateProjects.ts` + 两个测试文件;② migration `0008_drop_migrate_backup.sql` =
`DROP TABLE IF EXISTS chat_sessions_a_backup`(迁移稳定完结、无回滚需求,且生产备份表为空);
③ 前端 `splitWorkspaceSnapshot` / `buildWorkspaceSnapshotTurn` / `WORKSPACE_SNAPSHOT_ID` 符号
已随迁移码一并清净(PR-C 已删前端主体,PR-D 删迁移脚本里的最后引用)。
