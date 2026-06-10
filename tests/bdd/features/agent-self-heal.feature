Feature: Agent 自愈编译/编辑错误
  作为设计器
  我想把 iframe/工具的错误回填给 Agent
  以便它自己修复，无需用户介入

  Scenario: 失败的编辑被回填为错误并自动修复
    Given 一个含 form.jsx 的虚拟文件系统
    When Agent 先发出一个会失败的 str_replace 再发出修正的 write_file
    Then 第一次工具结果被标记为错误
    And 最终文件被成功修复
    And 本回合以纯文本结束
