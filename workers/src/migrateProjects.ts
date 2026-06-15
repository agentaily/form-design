// migrateProjects.ts — 一次性数据迁移：把老 `chat_sessions` 迁到 A' 「项目 ↔ 对话」模型（PR-B）。
//
// 背景（docs/refactor-project-conversation.md §2.3）：#76 时代把工作区快照（{ meta, fields }）
// 当一条合成 turn（id = `__agentaily_workspace_snapshot__`、kind = "workspace"）骑在每条会话的
// turns_json 里。A' 把工作区上提到**项目级**（新 `projects` 表，0007 / PR-A 已建）。本模块做
// 「老每条会话各自成为一个单对话项目，工作区取它原快照」的一次性搬迁：
//   1. 给每行老会话 mint 一个服务端 UUID `project_id`；
//   2. 从其 turns_json 抽出快照 turn 的 { meta, fields } → 写进新 `projects` 行（meta_json /
//      fields_json）；老 `form_slug` 上移到 `projects.form_slug`；created/updated 沿用该会话；
//   3. 把会话行 `project_id` 回填为新 project、**从 turns_json 删掉那条快照 turn**；title 留 NULL；
//   4. 没快照的老行（纯 §26/§65 时代）：同样 mint project，meta_json / fields_json 留 NULL（空工作区）。
//
// 铁律（§2.3）：
//   - **幂等**：只处理 `project_id IS NULL` 的行；写时 UPDATE 再带 `AND project_id IS NULL` 兜双跑。
//   - **先备份**：mutate 前把受影响行的**原始** turns_json + form_slug + mint 的 project_id 写进
//     库内备份表 {@link MIGRATION_BACKUP_TABLE}（INSERT OR IGNORE 保住首迁的 pristine 原值），让
//     {@link rollbackProjectMigration} 可精准回滚。**库外**再叠一层 `wrangler d1 export` 全量兜底
//     （见 workers/runbooks/0007-migrate-projects.md）。
//   - **不可逆**：删快照 turn 是有损写；靠先备份 + 幂等兜。**绝不**自己 apply 生产（卡老板点）。
//
// 复用：{@link splitWorkspaceSnapshot} 是 #76 前端 src/core/chatSessionClient.ts 同名纯逻辑的
// **迁移期移植**（workers 是独立子包，跨包 import 会拖进浏览器依赖，故移植这 ~15 行纯函数；
// 前端那份在 PR-C 切到项目级后删，本份是它的最后一次用途）。
//
// keying / 隔离（沿用 §26.8 纪律）：读 / 写一律可 `AND owner_id = ?` 收窄到单 owner（端点 owner-
// scoped：只迁调用者自己的行，A 动不了 B 的数据）。绝不存任何 owner 凭据。

/** 快照 turn 的 sentinel id（#76）。与前端 `WORKSPACE_SNAPSHOT_ID` 同值，迁移识别快照靠它。 */
export const WORKSPACE_SNAPSHOT_ID = "__agentaily_workspace_snapshot__";

/** 库内备份表名（一次性，迁移自建；PR-D 收口时随快照逻辑一并 DROP）。 */
export const MIGRATION_BACKUP_TABLE = "chat_sessions_a_backup";

/** apply / rollback 这类不可逆写要求的显式确认串（端点校验；防误触）。 */
export const MIGRATE_CONFIRM = "MIGRATE-A-PROJECTS";

/** 抽出的工作区模型（#76）：meta + fields。形状与前端 `WorkspaceSnapshot` 一致（类型放宽为 unknown）。 */
export interface WorkspaceSnapshot {
  meta: unknown | null;
  fields: unknown[];
}

/**
 * 把一段持久化 turns 数组拆成「真实对话 turns（快照已剔除）」与抽出的 {@link WorkspaceSnapshot}
 * （无快照时为 null）——#76 前端 `splitWorkspaceSnapshot` 的迁移期移植。纯函数，容忍空 / null /
 * 损坏输入（绝不抛——一行坏数据不该让整批迁移崩）。
 */
export function splitWorkspaceSnapshot(turns: readonly unknown[] | null | undefined): {
  turns: unknown[];
  workspace: WorkspaceSnapshot | null;
} {
  const real: unknown[] = [];
  let workspace: WorkspaceSnapshot | null = null;
  for (const t of turns ?? []) {
    if (t && typeof t === "object" && (t as { id?: unknown }).id === WORKSPACE_SNAPSHOT_ID) {
      const w = t as { meta?: unknown; fields?: unknown };
      workspace = {
        meta: w.meta ?? null,
        fields: Array.isArray(w.fields) ? w.fields : [],
      };
      continue;
    }
    real.push(t);
  }
  return { turns: real, workspace };
}

/** 防御性 JSON.parse 成数组：损坏 / 非数组 / 空 / null → []（绝不抛，同 chatSessions 纪律）。 */
function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 老 `chat_sessions` 行（迁移只读这几列；`project_id IS NULL` 才入选）。 */
export interface OldSessionRow {
  owner_id: string;
  session_id: string;
  turns_json: string | null;
  form_slug: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 单条会话的迁移计划——**纯函数**，便于内环直接 TDD。把一行老会话 + 一个已 mint 的 projectId
 * 算成「新 `projects` 行该写什么」「`chat_sessions` 行该改成什么」，不触库。
 *
 * - `metaJson`：有快照且 meta 非空 → JSON.stringify(meta)；否则 null（空 meta / 无快照）。
 * - `fieldsJson`：有快照 → JSON.stringify(fields)；**无快照 → null**（§2.3「空工作区留 NULL」）。
 * - `newTurnsJson`：有快照 → 剔除快照 turn 后的 turns 重序列化；**无快照 → null**（不动 turns_json，
 *   避免对纯 §26 老行做无谓 re-stringify churn）。
 * - `formSlug` / `createdAt` / `updatedAt`：原样从会话行迁到 project（§2.3 时间戳沿用会话）。
 */
export interface SessionMigrationPlan {
  ownerId: string;
  sessionId: string;
  /** mint 的服务端 project UUID。 */
  projectId: string;
  /** projects.meta_json 该写的值（null = 空）。 */
  metaJson: string | null;
  /** projects.fields_json 该写的值（null = 空工作区）。 */
  fieldsJson: string | null;
  formSlug: string | null;
  createdAt: string;
  updatedAt: string;
  /** chat_sessions.turns_json 该改成的值；null = 不改（无快照行）。 */
  newTurnsJson: string | null;
  /** 该行原本是否带 #76 工作区快照。 */
  hadSnapshot: boolean;
  /** 工作区字段数（报告用）。 */
  fieldCount: number;
  /** 快照里 meta.title（报告用；无 / 非字符串 → null）。 */
  titlePreview: string | null;
}

/** 把一行老会话 + 一个 mint 的 projectId 算成迁移计划（纯，绝不抛）。 */
export function planSessionMigration(row: OldSessionRow, projectId: string): SessionMigrationPlan {
  const turns = parseJsonArray(row.turns_json);
  const { turns: realTurns, workspace } = splitWorkspaceSnapshot(turns);
  const hadSnapshot = workspace !== null;

  const meta = workspace?.meta ?? null;
  const fields = workspace?.fields ?? [];
  const metaJson = meta == null ? null : JSON.stringify(meta);
  // 无快照 → fields_json 留 NULL（§2.3 空工作区）；有快照 → 序列化抽出的 fields（可能是 []）。
  const fieldsJson = hadSnapshot ? JSON.stringify(fields) : null;
  // 仅在真抽到快照时重写 turns_json（剔除那条合成 turn）；无快照行不动，避免 churn。
  const newTurnsJson = hadSnapshot ? JSON.stringify(realTurns) : null;

  const titlePreview =
    meta != null &&
    typeof meta === "object" &&
    typeof (meta as { title?: unknown }).title === "string"
      ? (meta as { title: string }).title
      : null;

  return {
    ownerId: row.owner_id,
    sessionId: row.session_id,
    projectId,
    metaJson,
    fieldsJson,
    formSlug: row.form_slug ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    newTurnsJson,
    hadSnapshot,
    fieldCount: fields.length,
    titlePreview,
  };
}

/** 迁移 / 回滚的结构化报告（端点直接 JSON 回，dry-run 给老板预览，apply / rollback 报实绩）。 */
export interface MigrationReport {
  mode: "dry-run" | "apply" | "rollback";
  /** 本次处理的会话数：migrate = `project_id IS NULL` 候选数；rollback = 备份行数。 */
  migrated: number;
  /** 其中带 #76 快照、抽出了工作区的会话数。 */
  withSnapshot: number;
  /** 其中无快照、迁成空工作区项目的会话数。 */
  withoutSnapshot: number;
  /** apply 时写进备份表的行数（dry-run / rollback = 0）。 */
  backedUp: number;
  /** rollback 时还原的会话数（migrate 时省略）。 */
  restored?: number;
  /** 前若干条样本，给老板肉眼核对「抽对了没」。 */
  samples: Array<{
    sessionId: string;
    projectId: string;
    hadSnapshot: boolean;
    fieldCount: number;
    title: string | null;
  }>;
}

/** 报告里 samples 最多带几条（够核对、不撑爆响应）。 */
const SAMPLE_LIMIT = 20;

function summarizePlans(
  mode: MigrationReport["mode"],
  plans: readonly SessionMigrationPlan[],
): Omit<MigrationReport, "backedUp" | "restored"> {
  const withSnapshot = plans.filter((p) => p.hadSnapshot).length;
  return {
    mode,
    migrated: plans.length,
    withSnapshot,
    withoutSnapshot: plans.length - withSnapshot,
    samples: plans.slice(0, SAMPLE_LIMIT).map((p) => ({
      sessionId: p.sessionId,
      projectId: p.projectId,
      hadSnapshot: p.hadSnapshot,
      fieldCount: p.fieldCount,
      title: p.titlePreview,
    })),
  };
}

/**
 * 建库内备份表（一次性，迁移自建）。单语句 `CREATE TABLE IF NOT EXISTS`，重复调用 no-op。
 * 主键 (owner_id, session_id) 让 INSERT OR IGNORE 在重跑时保住首迁写入的 pristine 原值。
 */
async function ensureBackupTable(db: D1Database): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_BACKUP_TABLE} (owner_id TEXT NOT NULL, session_id TEXT NOT NULL, turns_json TEXT NOT NULL, form_slug TEXT, minted_project_id TEXT NOT NULL, backed_up_at TEXT NOT NULL, PRIMARY KEY (owner_id, session_id))`,
  );
}

/** {@link migrateSessionsToProjects} 选项。 */
export interface MigrateOptions {
  /** true = 只读 + 报告、绝不写库（默认 false）。 */
  dryRun?: boolean;
  /** 收窄到单 owner（端点 owner-scoped）；不传 = 全部 owner。 */
  ownerId?: string | null;
  /** project id 生成器（测试可注入确定性 id）；默认 crypto.randomUUID。 */
  mintId?: () => string;
}

/**
 * 把老 `chat_sessions`（`project_id IS NULL`）迁到 A' 项目模型。**幂等**（只碰 NULL-project 行，
 * 写时再带 `AND project_id IS NULL`）。`dryRun` 时只读 + 算计划 + 报告、零写。apply 时**先备份**
 * 再在**一个 D1 batch（事务，全成或全回滚）**里逐行：备份 INSERT OR IGNORE → projects INSERT →
 * chat_sessions UPDATE（回填 project_id + 有快照才改 turns_json）。
 *
 * @returns 结构化 {@link MigrationReport}。
 */
export async function migrateSessionsToProjects(
  db: D1Database,
  opts: MigrateOptions = {},
): Promise<MigrationReport> {
  const dryRun = opts.dryRun ?? false;
  const ownerId = opts.ownerId ?? null;
  const mintId = opts.mintId ?? (() => crypto.randomUUID());

  // 1) 读候选行：幂等只取 project_id IS NULL（可再按 owner 收窄）。确定性排序便于样本稳定。
  const scoped = ownerId != null;
  const sql =
    `SELECT owner_id, session_id, turns_json, form_slug, created_at, updated_at` +
    ` FROM chat_sessions WHERE project_id IS NULL${scoped ? " AND owner_id = ?" : ""}` +
    ` ORDER BY owner_id, session_id`;
  const stmt = db.prepare(sql);
  const { results } = await (scoped ? stmt.bind(ownerId) : stmt).all<OldSessionRow>();
  const rows = results ?? [];

  // 2) 纯算计划（每行 mint 一个 project id）。
  const plans = rows.map((r) => planSessionMigration(r, mintId()));
  const base = summarizePlans(dryRun ? "dry-run" : "apply", plans);

  if (dryRun) return { ...base, backedUp: 0 };

  // 3) apply：先备份、再写。整批一个事务（D1 batch 原子）。
  await ensureBackupTable(db);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  plans.forEach((p, i) => {
    const original = rows[i];
    // ① 备份原始行。OR IGNORE 是防御性冗余（正常路径不可达：已迁行 project_id 非 NULL → 永不
    //    被重选为候选 → 永不重插）；保留它兜「备份行已存在」的意外，绝不覆盖首迁的 pristine 原值。
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO ${MIGRATION_BACKUP_TABLE}` +
            ` (owner_id, session_id, turns_json, form_slug, minted_project_id, backed_up_at)` +
            ` VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(p.ownerId, p.sessionId, original.turns_json ?? "[]", p.formSlug, p.projectId, now),
    );
    // ② 建项目行（projectId 新 mint，无冲突；时间戳沿用会话，§2.3）。
    statements.push(
      db
        .prepare(
          `INSERT INTO projects` +
            ` (owner_id, project_id, meta_json, fields_json, form_slug, created_at, updated_at)` +
            ` VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          p.ownerId,
          p.projectId,
          p.metaJson,
          p.fieldsJson,
          p.formSlug,
          p.createdAt,
          p.updatedAt,
        ),
    );
    // ③ 回填 project_id（+ 有快照才重写 turns_json）。WHERE 再带 project_id IS NULL 兜双跑。
    if (p.hadSnapshot) {
      statements.push(
        db
          .prepare(
            `UPDATE chat_sessions SET project_id = ?, turns_json = ?` +
              ` WHERE owner_id = ? AND session_id = ? AND project_id IS NULL`,
          )
          .bind(p.projectId, p.newTurnsJson, p.ownerId, p.sessionId),
      );
    } else {
      statements.push(
        db
          .prepare(
            `UPDATE chat_sessions SET project_id = ?` +
              ` WHERE owner_id = ? AND session_id = ? AND project_id IS NULL`,
          )
          .bind(p.projectId, p.ownerId, p.sessionId),
      );
    }
  });

  if (statements.length > 0) await db.batch(statements);

  return { ...base, backedUp: plans.length };
}

/** {@link rollbackProjectMigration} 选项。 */
export interface RollbackOptions {
  /** 收窄到单 owner（端点 owner-scoped）；不传 = 全部 owner。 */
  ownerId?: string | null;
}

/**
 * 从库内备份表回滚一次迁移：逐行还原**原始** turns_json、把 `project_id` 置回 NULL、删掉 mint 的
 * 项目行、消费掉该备份行。一个 D1 batch（事务）。备份表不存在 / 无行 → no-op（restored 0）。
 *
 * 这是「验回滚」的可测路径；生产侧另有 `wrangler d1 export` 全量兜底（runbook）。
 */
export async function rollbackProjectMigration(
  db: D1Database,
  opts: RollbackOptions = {},
): Promise<MigrationReport> {
  const ownerId = opts.ownerId ?? null;
  await ensureBackupTable(db); // 备份表不存在也不报错（CREATE IF NOT EXISTS）。
  const scoped = ownerId != null;
  const sel = db.prepare(
    `SELECT owner_id, session_id, turns_json, minted_project_id` +
      ` FROM ${MIGRATION_BACKUP_TABLE}${scoped ? " WHERE owner_id = ?" : ""}`,
  );
  const { results } = await (scoped ? sel.bind(ownerId) : sel).all<{
    owner_id: string;
    session_id: string;
    turns_json: string;
    minted_project_id: string;
  }>();
  const backups = results ?? [];

  const statements: D1PreparedStatement[] = [];
  for (const b of backups) {
    statements.push(
      db
        .prepare(
          `UPDATE chat_sessions SET turns_json = ?, project_id = NULL` +
            ` WHERE owner_id = ? AND session_id = ?`,
        )
        .bind(b.turns_json, b.owner_id, b.session_id),
    );
    statements.push(
      db
        .prepare(`DELETE FROM projects WHERE owner_id = ? AND project_id = ?`)
        .bind(b.owner_id, b.minted_project_id),
    );
    statements.push(
      db
        .prepare(`DELETE FROM ${MIGRATION_BACKUP_TABLE} WHERE owner_id = ? AND session_id = ?`)
        .bind(b.owner_id, b.session_id),
    );
  }
  if (statements.length > 0) await db.batch(statements);

  return {
    mode: "rollback",
    migrated: 0,
    withSnapshot: 0,
    withoutSnapshot: 0,
    backedUp: 0,
    restored: backups.length,
    samples: [],
  };
}
