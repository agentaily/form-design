---
"agentaily-forms": minor
---

feat(feishu): 发布即按字段类型在飞书预建对应列 + 提交按列类型写值

- **发布 / 编辑表单即预建列**:发布(`POST /api/forms`)/ 编辑(`PATCH …/:slug` 改 fields)时,按字段 `type` 在 owner 飞书多维表格预建对应类型的列(数字 / 日期 / 单选 / 多选列,而非一律文本),owner 发布后立刻看到完整且类型正确的结构。
- **best-effort**:owner 未配飞书 / 飞书连不上 / 换 token 失败 / 建列失败 → 发布仍 `201`,预建经 `waitUntil` 后台静默跳过(只记 `err.name`、绝不记凭据)。
- **提交按列真实类型写值**:`POST /api/submit` 先 `listBitableColumns` 拿每列真实类型再格式化值(数字→number、日期→毫秒戳、多选→数组),兜旧文本列 / 类型漂移;脏数字 / 坏日期省略该格不整条失败。
- **自愈升级**:§15.8 自愈从「一律文本列」升级为「按字段 `type` 建对应类型列」,且缺列按字段映射类型格式化值、摊平 `group` 子字段。
- 单一真相源 `FIELD_TYPE_TO_BITABLE`(建列与写值共用);SPEC §16.8 / §15.8 升级。
