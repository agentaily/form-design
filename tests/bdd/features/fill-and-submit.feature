Feature: 答题者填写并提交表单
  作为答题者
  我想填写公开表单
  以便提交我的报名

  Scenario: 必填校验拦住空提交
    Given 一个含必填「姓名」的表单
    When 答题者直接点击提交
    Then 出现必填校验提示

  Scenario: 填好后提交成功
    Given 一个含必填「姓名」的表单
    When 答题者填写「姓名」并点击提交
    Then 出现报名成功态
