Feature: 主题持久化(跨子域)
  作为表单作者
  我希望在设计器里切换的亮/暗主题被记住、刷新后仍生效
  以便不会每次重新加载都回落到默认 dark,且与营销站(同一 *.agentaily.com 子域)主题保持一致

  背景(SPEC §27 · 接 @agentaily/design-system 的 ThemeProvider/useTheme):主题不再是设计器的内存态,而是
  通过 design-system 的跨子域 cookie(`agentaily:theme`,`domain=.agentaily.com`;localhost 自动回退
  localStorage)持久化 —— 与营销站(form-design-website,已正确)共用同一存储键 + 默认 dark + 同一段
  防 FOUC 首屏内联脚本(`themeInitScript({defaultTheme:"dark"})`,与营销站逐字节一致)。设计器顶栏的
  主题钮在亮/暗间二态切换;split/density/formStyle 仍是固定产品默认,非用户持久化(本特性不动它们)。

  Scenario: 无持久化偏好时默认 dark
    Given owner 从未切换过主题(无任何持久化偏好)
    When 进入设计器
    Then 文档主题为 dark

  Scenario: 设计器读回已持久化的主题(刷新后不回落 dark)
    Given 已持久化的主题偏好是 light
    When 进入设计器
    Then 文档主题为 light

  Scenario: 在设计器切换主题会写入持久化存储
    Given owner 从未切换过主题(无任何持久化偏好)
    When 进入设计器并点击主题钮
    Then 文档主题为 light
    And 持久化存储里的主题偏好是 light

  Scenario: 切换后重新加载仍保持所选主题
    Given owner 从未切换过主题(无任何持久化偏好)
    When 进入设计器并点击主题钮
    And 重新加载设计器
    Then 文档主题为 light
