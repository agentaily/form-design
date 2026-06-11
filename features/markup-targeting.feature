Feature: 作者在预览区指向修改
  作为表单作者
  我想直接指向预览里的某个元素并描述要怎么改
  以便不必在对话里用文字费力描述「右侧那个提交按钮」

  Background:
    Given 一份含「姓名」「邮箱」字段、封面与提交按钮的表单
    And 预览处于「预览」标签

  Scenario: 有字段时可进入「指向修改」模式
    When 作者点击预览工具栏的「指向修改」
    Then 进入指向修改模式
    And 「指向修改」按钮点亮为选中态
    And 顶部提示「移到要改的地方，点击它再描述修改」

  Scenario: 空表单时「指向修改」入口禁用
    Given 一份没有任何字段的表单
    Then 预览工具栏的「指向修改」处于禁用态

  Scenario: 仅在「预览」标签下才有「指向修改」入口
    When 作者切到「Schema」标签
    Then 预览工具栏不显示「指向修改」入口

  Scenario: hover 高亮光标下最近的可定位元素并显示其身份
    Given 作者处于指向修改模式
    When 作者把光标移到「姓名」字段上
    Then 该字段出现高亮框
    And 高亮框左上角显示身份标签「姓名 · 输入框」

  Scenario: click 选中元素并在其下方弹出 composer
    Given 作者处于指向修改模式
    When 作者点击「提交按钮」
    Then 该元素被选中并冻结 hover 高亮
    And 其下方弹出修改 composer
    And composer 顶部回显身份「提交按钮 · 按钮」
    And 顶部提示变为「输入修改要求，发送到左侧对话」

  Scenario: 发送把带身份的消息送进左侧对话并退出模式
    Given 作者在指向修改模式下选中了「提交按钮」
    When 作者输入「改成『立即报名』」并点击「发送到对话」
    Then 左侧对话新增一条用户消息「〔提交按钮 · 按钮〕改成『立即报名』」
    And 退出指向修改模式

  Scenario: 无 kind 的元素发送时只带 label
    Given 一个只有 label、没有 kind 的可定位元素被选中
    When 作者输入「换个封面图」并发送
    Then 左侧对话新增一条用户消息「〔封面〕换个封面图」

  Scenario: 空 note 不可发送
    Given 作者在指向修改模式下选中了某个元素
    When 修改输入框为空或只含空白
    Then 「发送到对话」按钮不可用

  Scenario: Esc 在选中态先取消选中
    Given 作者在指向修改模式下选中了某个元素
    When 作者按 Esc
    Then 取消选中并关闭 composer
    And 仍处于指向修改模式

  Scenario: Esc 在未选中态退出模式
    Given 作者处于指向修改模式且未选中任何元素
    When 作者按 Esc
    Then 退出指向修改模式

  Scenario: ✕「退出」按钮退出模式
    Given 作者处于指向修改模式
    When 作者点击顶部提示里的「退出」
    Then 退出指向修改模式

  Scenario: 取消按钮放弃当前选中
    Given 作者在指向修改模式下选中了某个元素
    When 作者点击 composer 的「取消」
    Then 取消选中并关闭 composer
    And 仍处于指向修改模式

  Scenario Outline: 字段类型映射为中文 kind
    Given 一个类型为 <type> 的字段被选中
    Then 其身份 kind 为 <kind>

    Examples:
      | type     | kind     |
      | text     | 输入框    |
      | tel      | 输入框    |
      | email    | 输入框    |
      | textarea | 多行文本  |
      | radio    | 单选      |
      | checks   | 多选      |
      | select   | 下拉选择  |
      | consent  | 勾选项    |

  Scenario: label 去掉末尾必填星
    Given 一个 label 为「手机号 *」的必填字段被选中
    Then 其身份 label 为「手机号」
