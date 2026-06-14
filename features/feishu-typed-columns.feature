# 契约来源：后端 SPEC §16.8（发布即在飞书表 best-effort 预建带类型的列）+ §16.9（发布即自动建表，
# 每表单一张飞书多维表格）+ §15.8 升级（submit 自愈 / 写值升级为「按字段 type 建对应类型列 +
# 按列真实类型写值」）。
#
# 发布即自动建表（§16.9，PR-3）：owner 现在只配**账户级**飞书凭据（app_id + app_secret）；发布一份
# 表单时系统就先在飞书替他**自动建一张 per-form 多维表格**（建 app + 建数据表 + 回写定位进 form 行），
# 再在这张新表上预建带类型的列。所以下文「owner 已配置可用的飞书多维表格凭据」现在的含义是
# **「owner 配了 app_id + app_secret」**——不再要求 owner 自己先建表 / 粘 app_token / table_id。
# best-effort 铁律延伸到建表：未配飞书 / 建 app / 建 table / 建列任一失败都不挡发布（表单照常发布成功，
# 该表单的飞书表定位留空 = 暂无飞书表）。提交同步 / 编辑预建 / 改名都改读**该表单自己那张 per-form 表**。
#
# 背景：在此 feature 前，owner 发布表单完全不碰飞书，列只在首次提交撞缺列时由 §15.8 自愈
# 一列列懒建、且一律文本列——owner 发布后看不到完整结构，number/date/select 全落成文本列。
# 本 feature 把两件事补齐：①发布 / 编辑即按字段 type 把对应类型的列预建好；②提交时按列的
# 真实类型格式化值写入。失败策略 = best-effort：owner 未配飞书 / 飞书连不上 / token 换取失败 /
# 建列失败 → 发布仍成功（照常写 D1、返回 201），预建静默跳过（只记日志，不阻塞、不报错）。
#
# 类型 / 映射 / 函数契约桩见 workers/src/feishu-schema.ts（FIELD_TYPE_TO_BITABLE 单一真相源 /
# toBitableFieldType / buildFieldProperty / formatValueForBitable / preCreateBitableColumns(BestEffort) /
# listBitableColumns）+ workers/src/submit.ts（answersToTypedFields / ensureBitableFields /
# writeRecordWithFieldEnsure 的 §16.8 升级）+ 接线 workers/src/index.ts（POST /api/forms 与
# PATCH /api/forms/:slug 的 waitUntil 预建、POST /api/submit 的列出+类型写值）。
#
# 字段 type → 飞书列类型映射（§16.8 单一真相）：
#   text/file/group → 文本(1)·number → 数字(2)·date → 日期(5,毫秒时间戳)·
#   select/radio → 单选(3,带 options)·checkbox → 多选(4,带 options)·未知 → 文本(1)。
Feature: 发布表单即在飞书预建类型正确的列，提交按类型写值
  作为表单作者(owner)
  我想发布表单时系统就在我的飞书多维表格里按字段类型把列建好、提交时按类型写值
  以便我发布后立刻看到完整且类型正确的表结构，而非等首次提交才一列列懒长出文本列

  # —— 发布即自动建表（§16.9）：先替 owner 建一张 per-form 飞书多维表格，再在其上预建列 ——

  Scenario: 发布即在飞书自动建一个 app + 数据表并把定位回写进该表单
    Given owner 已配置可用的飞书多维表格凭据
    And 设计器里有一份可发布的表单
    When owner 发布该表单
    Then 系统在飞书新建一个多维表格 app 并拿到它的 app token
    And 在该 app 下新建一张数据表并拿到它的 table id
    And 这张表单记下它自己的飞书 app token 与 table id
    And 随后在这张新表上预建该表单字段对应类型的列

  Scenario: owner 未配飞书时发布不建表（表单照常发布成功）
    Given owner 尚未配置飞书凭据
    And 设计器里有一份可发布的表单
    When owner 发布该表单
    Then 发布成功并返回该表单的 slug
    And 不向飞书发起任何建表调用
    And 这张表单没有飞书表

  Scenario: 建 app 失败时发布仍成功且该表单没有飞书表
    Given owner 已配置飞书凭据但飞书建多维表格 app 被拒
    And 设计器里有一份可发布的表单
    When owner 发布该表单
    Then 发布成功并返回该表单的 slug
    And 这张表单没有飞书表
    And 日志只记录错误名而绝不记录 app_secret 或 tenant_access_token

  # —— 发布即预建：自动建表成功后在这张 per-form 表上按字段 type 预建全部列 ——

  Scenario: 发布一份多类型字段的表单即预建对应类型的列
    Given owner 已配置可用的飞书多维表格凭据
    And 设计器里有一份含「姓名(文本)、年龄(数字)、生日(日期)、城市(单选)、兴趣(多选)」的表单
    When owner 发布该表单
    Then 发布成功并返回该表单的 slug
    And 飞书表里按字段类型预建出对应的列
    And 数字字段建成数字列、日期字段建成日期列、单选字段建成带选项的单选列、多选字段建成带选项的多选列
    And 文本字段建成文本列

  Scenario: 单选与多选字段预建时带上其选项
    Given owner 已配置可用的飞书多维表格凭据
    And 设计器里有一个单选字段「城市」其选项为「北京、上海、广州」
    When owner 发布该表单
    Then 飞书表里建出一个单选列「城市」
    And 该列的候选项包含「北京、上海、广州」

  Scenario: 未知或不支持的字段类型预建为文本列
    Given owner 已配置可用的飞书多维表格凭据
    And 设计器里有一个文件上传字段
    When owner 发布该表单
    Then 该字段在飞书表里建成文本列而非报错

  # —— best-effort 失败策略:预建出任何岔子都不拖垮发布 ——

  Scenario: owner 未配飞书时发布仍成功且静默跳过预建
    Given owner 尚未配置飞书凭据
    And 设计器里有一份可发布的表单
    When owner 发布该表单
    Then 发布成功并返回该表单的 slug
    And 不向飞书发起任何调用
    And 预建被静默跳过且不产生任何错误

  Scenario: 飞书连不上时发布仍成功且静默跳过预建
    Given owner 已配置飞书凭据但飞书上游不可达
    And 设计器里有一份可发布的表单
    When owner 发布该表单
    Then 发布成功并返回该表单的 slug
    And 预建被静默跳过且不产生任何错误
    And 日志只记录错误名而绝不记录 app_secret 或 tenant_access_token

  Scenario: 换取 tenant_access_token 失败时发布仍成功
    Given owner 已配置飞书凭据但换取 token 失败
    And 设计器里有一份可发布的表单
    When owner 发布该表单
    Then 发布成功并返回该表单的 slug
    And 预建被静默跳过且不产生任何错误

  Scenario: 某一列建列失败时发布仍成功
    Given owner 已配置可用的飞书多维表格凭据但其中一列建列被飞书拒绝
    And 设计器里有一份可发布的表单
    When owner 发布该表单
    Then 发布成功并返回该表单的 slug
    And 建列失败被静默吞掉且不影响发布响应

  # —— 幂等 / 不改既有列:预建只对缺列生效 ——

  Scenario: 预建跳过已存在的列且绝不改其类型
    Given owner 的飞书表里已存在一个名为「姓名」的文本列
    And 设计器里有一份含「姓名」字段的表单
    When owner 发布该表单
    Then 名为「姓名」的列被跳过、其类型保持不变
    And 不向已存在的列发起改类型调用

  Scenario: 并发下重复建列被当作幂等成功
    Given owner 发布表单时某列恰被另一处并发建好
    When 预建尝试建该列收到飞书的重复列码
    Then 该列被视为已建成而非失败
    And 预建继续建其余缺列

  # —— 编辑增量:PATCH /api/forms/:slug 改了 fields 只增量补建新增列 ——

  Scenario: 编辑给表单新增一个数字字段时增量补建对应列
    Given owner 已发布过一份表单且飞书表里已有它原有字段的列
    When owner 编辑该表单新增一个数字字段「分数」并保存
    Then 编辑成功
    And 飞书表里增量补建出一个数字列「分数」
    And 原有已存在的列被跳过、未被改动

  Scenario: 编辑未改动 fields 时不触发预建
    Given owner 已发布过一份表单
    When owner 仅把该表单状态改为关闭而未改动字段
    Then 编辑成功
    And 不触发任何预建调用

  # —— 提交按列真实类型写值落库（既有列冲突兜底方案 a：先列出列真实类型再格式化）——

  Scenario: 提交把数字答案按数字列写入
    Given 一份已发布表单的飞书表里「年龄」是数字列
    When 答题者提交「年龄」为「28」
    Then 提交成功并返回 recordId
    And 「年龄」以数字而非文本写入飞书

  Scenario: 提交把日期答案按毫秒时间戳写入日期列
    Given 一份已发布表单的飞书表里「生日」是日期列
    When 答题者提交「生日」为一个日期串
    Then 提交成功并返回 recordId
    And 「生日」以毫秒时间戳写入日期列

  Scenario: 提交把多选答案按多选列写入字符串数组
    Given 一份已发布表单的飞书表里「兴趣」是多选列
    When 答题者提交「兴趣」为「阅读、运动」
    Then 提交成功并返回 recordId
    And 「兴趣」以字符串数组写入多选列

  Scenario: 数字列收到非数字脏值时跳过该格而不整条失败
    Given 一份已发布表单的飞书表里「年龄」是数字列
    When 答题者在「年龄」里填了一个非数字串
    Then 该非数字的「年龄」格被跳过不写入
    And 其余字段照常写入且提交成功

  Scenario: 旧文本列按其真实类型写值而非按字段声明类型
    Given 一份表单的飞书表里「年龄」此前被自愈建成了文本列
    And 该表单的「年龄」字段声明类型现在是数字
    When 答题者提交「年龄」
    Then 「年龄」按列的真实类型(文本)写入而不被飞书因类型不符整条拒绝
    And 提交成功并返回 recordId

  # —— 提交路径的自愈兜底升级:缺列时按字段 type 建对应类型列再重试一次 ——

  Scenario: 提交遇缺列时按字段类型自愈建列再重试
    Given 一份已发布表单的飞书表里还缺一个数字字段对应的列
    When 答题者首次提交触发该列缺失
    Then 后端按该字段类型把缺列建成数字列
    And 补列后重试一次写入并提交成功

  # —— 凭据边界:全程不出网 ——

  Scenario: 提交成功响应只含 ok 与 recordId
    Given 一份可正常写入的已发布表单
    When 答题者提交
    Then 响应只含 ok 与 recordId
    And 响应里绝不含写入的字段值、tenant_access_token 或 app_secret
