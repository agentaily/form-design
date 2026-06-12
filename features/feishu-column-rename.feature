# 契约来源：后端 SPEC §16.8.7（改字段标签 → 同步飞书列改名，best-effort，v1 只改名）。
#
# 背景：§15.3 约定「飞书列名 = field.label」，列匹配靠 label。于是 owner 在设计器里把某字段
# label 改了再保存（PATCH /api/forms/:slug 带 fields），编辑路径的预建（§16.8.1）会按**新 label**
# 找不到同名列、**新建一列**——把**旧列连同其中已收集的数据**孤零零留在表里，数据分家。本 feature
# 让编辑识别出「这是同一个字段（id 不变）被改了名」，去把飞书里**那一列改名**，而不是新建。
#
# 定位机制：Field 有稳定 id（改名后不变）。编辑同时拿得到旧字段定义（落库前的 schema_json）与新
# 字段定义（PATCH body）。按 field.id 配对 diff：id 在两边都有、label 不同 = 改名；**旧 label 就是
# 飞书那列现在的名字**，据此定位该列的飞书 field_id → 调改名 API 改成新 label。group 子字段经
# flattenLeafFields 摊平后一并参与。
#
# 顺序铁律：同一 waitUntil 里**先改名、后预建**——改名把现有列改成新名，预建随后列出现有列只建缺的、
# 看到已改名的列就跳过，绝不重复建；若反过来先建，会按新 label 建出一个重复列。
#
# v1 范围（用户已拍）：只同步「改名」。删字段 → 列保留不动（绝不删已收数据）；改类型 → 列不动
# （§16.8.4 兜值）；新增字段 → 沿用预建建列；排序不同步。
#
# best-effort：owner 未配飞书 / 飞书连不上 / token 换取失败 / 列出失败 / 改名失败 → 编辑仍 200，
# 改名静默跳过（waitUntil 后台只记 err.name，绝不记凭据 / 列值）。冲突逐项跳过、互不影响。
#
# 类型 / 函数契约桩见 workers/src/feishu-schema.ts（computeFieldRenames 纯 diff /
# renameBitableColumn 调飞书 PUT fields/{field_id} / syncBitableColumnRenamesBestEffort 外壳 /
# listBitableColumnsDetailed 含 field_id），接线见 workers/src/index.ts 的 PATCH /api/forms/:slug。
Feature: 改字段标签时同步把飞书对应列改名而非新建一列
  作为表单作者(owner)
  我想在设计器里把某字段的标签改了再保存时，系统就把我飞书表里那一列改名
  以便已收集的数据继续留在同一列里，而不是新长出一列、把旧数据连同旧列丢在一边

  # —— 核心：改 label → 改名那一列、不新建 ——

  Scenario: 改一个字段的标签时飞书把对应列改名而不新建列
    Given owner 已配置可用的飞书多维表格凭据
    And owner 已发布过一份含字段「电话」的表单且飞书表里有一个名为「电话」的列
    When owner 编辑该表单把「电话」字段的标签改为「联系电话」并保存
    Then 编辑成功
    And 飞书表里那一列被改名为「联系电话」
    And 系统不在飞书新建名为「联系电话」的列
    And 改名前已收集到「电话」列里的数据仍在这一列里

  Scenario: 改名按字段 id 配对而非按标签文本匹配
    Given owner 已配置可用的飞书多维表格凭据
    And owner 已发布过一份表单其中某字段 id 不变但标签从「旧名」改成了「新名」
    When owner 保存该编辑
    Then 系统据该字段不变的 id 认出这是同一字段被改名
    And 用其旧标签「旧名」在飞书定位到对应列并改名为「新名」

  Scenario: 改名时带回该列原有类型只改名不改类型
    Given owner 的飞书表里「年龄」是一个数字列
    And owner 把「年龄」字段的标签改为「周岁」
    When owner 保存该编辑
    Then 飞书改名调用带上该列原有的数字类型
    And 该列改名为「周岁」后仍是数字列

  # —— 顺序铁律：改名先于预建，避免重复建列 ——

  Scenario: 改名先于预建因而被改名的列不会被预建重复建出
    Given owner 已配置可用的飞书多维表格凭据
    And owner 把「电话」字段改名为「联系电话」并同时新增一个字段「邮箱」
    When owner 保存该编辑
    Then 系统先把「电话」列改名为「联系电话」再做预建
    And 预建看到「联系电话」列已存在便跳过它
    And 预建只为新增的「邮箱」字段建出一个新列
    And 飞书表里不存在两个「联系电话」列

  # —— 分组子字段改名 ——

  Scenario: 分组里的子字段改名也同步到飞书列
    Given owner 已配置可用的飞书多维表格凭据
    And owner 表单的某个分组里有一个子字段其飞书列名为「街道」
    When owner 把该子字段标签从「街道」改为「详细地址」并保存
    Then 飞书表里「街道」列被改名为「详细地址」

  # —— v1 范围：删 / 改类型 / 排序不同步，新增照常建列 ——

  Scenario: 删字段时飞书那一列保留不动且不删已收数据
    Given owner 已配置可用的飞书多维表格凭据
    And owner 已发布过一份含字段「备注」的表单且飞书「备注」列里已有数据
    When owner 编辑该表单删除「备注」字段并保存
    Then 编辑成功
    And 飞书表里「备注」列仍在且其中已收集的数据未被删除
    And 系统不向飞书发起任何删列调用

  Scenario: 新增字段照常预建对应列且不触发改名
    Given owner 已配置可用的飞书多维表格凭据
    And owner 已发布过一份表单
    When owner 编辑该表单仅新增一个字段「分数」并保存
    Then 编辑成功
    And 飞书表里增量建出一个「分数」列
    And 系统不发起任何改名调用

  Scenario: 仅改字段类型而标签不变时不触发改名
    Given owner 已配置可用的飞书多维表格凭据
    And owner 把某字段类型从文本改成数字但标签保持不变
    When owner 保存该编辑
    Then 系统不向飞书发起任何改名调用
    And 飞书那一列保持不动

  # —— 不触发改名的编辑形态 ——

  Scenario: 只改状态不改 fields 时不触发改名
    Given owner 已配置可用的飞书多维表格凭据
    And owner 已发布过一份表单
    When owner 仅把该表单状态改为关闭而未在请求里带 fields
    Then 编辑成功
    And 系统既不预建也不改名

  Scenario: 编辑带了 fields 但没有任何标签变更时不发改名调用
    Given owner 已配置可用的飞书多维表格凭据
    And owner 编辑里带了 fields 但所有字段标签都和原来一样
    When owner 保存该编辑
    Then 系统不发起任何改名调用

  # —— 冲突 / 边界：逐项跳过、互不影响、绝不报错 ——

  Scenario: 改名撞上已存在的另一个列名时跳过且不强改
    Given owner 已配置可用的飞书多维表格凭据
    And owner 把「电话」字段改名为「邮箱」但飞书表里已另有一个不同的「邮箱」列
    When owner 保存该编辑
    Then 编辑成功
    And 系统跳过这次会撞名的改名且不覆盖已存在的「邮箱」列
    And 跳过被记入日志且日志不含任何凭据

  Scenario: 旧标签在飞书找不到对应列时跳过该项改名
    Given owner 把某字段改名但其旧标签在飞书表里根本没有对应列
    When owner 保存该编辑
    Then 编辑成功
    And 系统跳过这一项改名而不报错

  Scenario: 多项改名中某一项失败不影响其它项与编辑
    Given owner 在一次编辑里改了两个字段的标签
    And 其中一项的改名被飞书拒绝
    When owner 保存该编辑
    Then 编辑成功
    And 另一项改名照常生效
    And 失败那一项被静默跳过

  # —— best-effort：飞书未配 / 连不上 / 换 token 失败 → 编辑仍 200 静默跳过 ——

  Scenario: owner 未配飞书时改名静默跳过且编辑仍成功
    Given owner 尚未配置飞书凭据
    And owner 编辑某表单改了一个字段的标签
    When owner 保存该编辑
    Then 编辑成功并返回更新后的表单
    And 不向飞书发起任何调用

  Scenario: 飞书连不上时改名静默跳过且编辑仍成功
    Given owner 已配置飞书凭据但飞书上游不可达
    And owner 编辑某表单改了一个字段的标签
    When owner 保存该编辑
    Then 编辑成功并返回更新后的表单
    And 改名被静默跳过且不产生任何错误
    And 日志只记录错误名而绝不记录 app_secret 或 tenant_access_token

  Scenario: 换取 tenant_access_token 失败时改名静默跳过且编辑仍成功
    Given owner 已配置飞书凭据但换取 token 失败
    And owner 编辑某表单改了一个字段的标签
    When owner 保存该编辑
    Then 编辑成功并返回更新后的表单
    And 改名被静默跳过且不产生任何错误

  # —— 凭据边界 ——

  Scenario: 改名全程不把凭据或列值写进响应或日志
    Given owner 已配置可用的飞书多维表格凭据
    When owner 编辑某表单改了一个字段的标签并保存
    Then 编辑响应只含更新后的表单视图而不含任何凭据
    And 任何改名相关日志都不含 app_secret、tenant_access_token 或被改的列值
