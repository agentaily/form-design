Feature: 作者复制字段
  作为表单作者
  我想复制一个已有字段
  以便在它后面快速得到一个内容相同、id 不同的副本

  Scenario: 复制字段在其后插入一个内容相同、id 不同的副本
    Given 一个含「姓名」「邮箱」两个字段的 schema
    When 作者复制「姓名」字段
    Then 副本被插入到「姓名」字段之后
    And 副本与原字段内容相同
    And 副本的 id 与原字段不同
    And schema 共有 3 个字段

  Scenario: 复制不存在的字段会报错
    Given 一个含「姓名」「邮箱」两个字段的 schema
    When 作者复制一个不存在的字段 id
    Then 操作抛出「字段未找到」错误
    And schema 字段数量保持不变
