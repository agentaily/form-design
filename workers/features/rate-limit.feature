Feature: 公开端点限流 / 防刷 按 IP 固定窗口计数 超限 429 + Retry-After
  作为运行平台
  我想给公开端点按访客 IP 做固定窗口限流，超限就回 429 并告知何时可重试
  以便挡住刷子烧 owner 的飞书写额度与全平台共享的 Resend 发信额度、并防登录密码爆破，同时不误伤正常答题者 / 访客、不波及 owner-only 与探活 / 预检

  背景：BYOK 下 owner-only 端点各烧自己额度（§11），不限流；要限的是被匿名访客调用却消耗共享资源的公开端点——
  POST /api/submit（写 owner 飞书表，烧 owner 飞书写额度）、POST /api/auth/register 与
  POST /api/auth/password-reset/request（发邮件走共享 Resend 免费档 100/天）、POST /api/auth/login（密码爆破面）。
  用 Cloudflare KV 做按 IP 的固定窗口计数器：取 CF-Connecting-IP 真实访客 IP（缺失归一到一个常量兜底桶、仍限），
  计数键为 hash(ip) + 端点类别 + 当前窗口起点（绝不存原始 IP），KV 值是计数、TTL = 窗口长度（到期自动清）。
  读当前计数 ≥ 上限即拒，否则自增放行。超限统一 429 + Retry-After（秒，到窗口重置）。
  限流中间件只逐条挂在具体公开端点上（method + path 级），排在 CORS 中间件之后；
  绝不宽匹配 /api/*、绝不在 OPTIONS 预检上触发、绝不挂 owner-only 与 /health。
  限流是「尽力防滥用」不是「强一致门禁」：KV 读 / 写抛错一律 fail-open（放行），绝不因限流器自身故障把正常请求打挂。

  # --- 正常请求放行（限额内不受影响）-----------------------------------------

  Scenario: 限额内的公开端点请求正常放行
    Given 一个挂了限流的公开端点
    And 当前 IP 在该端点窗口内的请求数还在上限以内
    When 该 IP 再发一次请求
    Then 请求被放行进入该端点的业务逻辑
    And 响应状态码与响应体与未挂限流时一致
    And 响应没有被改写成 429

  Scenario: 不同 IP 各自独立计数互不影响
    Given 一个挂了限流的公开端点
    And 一个 IP 已把该端点窗口内的配额刷满
    When 另一个不同 IP 对同一端点发请求
    Then 该请求被放行
    And 它不受第一个 IP 已超限的影响

  Scenario: 不同端点各自独立计数互不串桶
    Given 同一个 IP 已把 POST /api/auth/login 的窗口配额刷满
    When 该 IP 对 POST /api/auth/register 发一次请求
    Then 该 register 请求不因 login 已超限而被拒
    And 它按 register 自己的配额判定

  # --- 超限 429 + Retry-After --------------------------------------------------

  Scenario: 同一 IP 在窗口内超过上限返回 429
    Given 一个挂了限流的公开端点
    And 某 IP 已在当前窗口内达到该端点的请求上限
    When 该 IP 在同一窗口内再发一次请求
    Then 响应状态码为 429
    And 响应体是一个中性的 error 文案
    And 该次请求没有进入该端点的业务逻辑

  Scenario: 超限响应带 Retry-After 头告知何时可重试
    Given 某 IP 已对某公开端点触发限流
    When 该 IP 再发一次被拒的请求
    Then 响应状态码为 429
    And 响应头带有 Retry-After
    And Retry-After 是一个表示到窗口重置剩余秒数的非负整数

  Scenario: 超限用 429 而非 503
    Given 某 IP 已对某公开端点触发限流
    When 该 IP 再发一次被拒的请求
    Then 响应状态码为 429
    And 响应状态码不是 503

  Scenario: submit 端点的分钟与小时双窗口任一命中即拒
    Given POST /api/submit 同时挂了每分钟与每小时两个窗口
    And 某 IP 在一分钟内的提交数已达到分钟上限但未达小时上限
    When 该 IP 在同一分钟内再提交一次
    Then 响应状态码为 429
    And Retry-After 反映命中的那个窗口到重置的剩余秒数

  # --- 窗口重置后恢复 ----------------------------------------------------------

  Scenario: 窗口过期后计数清零请求恢复放行
    Given 某 IP 已在当前窗口内对某公开端点触发限流
    When 时间推进到下一个固定窗口
    And 该 IP 再发一次请求
    Then 该请求被放行
    And 它进入该端点的业务逻辑

  # --- KV 故障 fail-open --------------------------------------------------------

  Scenario: KV 读写故障时 fail-open 仍放行正常请求
    Given 一个挂了限流的公开端点
    And 限流计数所依赖的 KV 读或写抛错
    When 一个正常请求到达该端点
    Then 该请求被放行
    And 响应状态码与未限流时一致而不是 429 或 5xx

  Scenario: fail-open 时不向日志或响应泄漏 IP 与键
    Given 限流计数所依赖的 KV 抛错触发 fail-open
    When 该请求被放行
    Then 整个响应里不包含访客原始 IP
    And 整个响应里不包含限流计数键的内容

  # --- 隐私：不存原始 IP -------------------------------------------------------

  Scenario: 限流计数键不写入原始 IP 明文
    Given 一个带 CF-Connecting-IP 的请求命中某限流端点
    When 限流器为该请求计数
    Then 写入 KV 的键由 IP 的单向哈希加端点类别加窗口起点组成
    And 写入 KV 的键与值都不包含原始 IP 明文

  Scenario: 缺少 CF-Connecting-IP 时归入兜底桶且仍限流
    Given 一个不带 CF-Connecting-IP 头的请求
    When 该来源对某限流端点高频发请求并超过上限
    Then 这些无 IP 请求共享同一个常量兜底桶
    And 超过兜底桶上限后同样被限为 429

  # --- 不受限的面：owner-only / health / OPTIONS 预检 --------------------------

  Scenario: owner-only 端点不受公开端点限流影响
    Given 一个已登录的 owner 持有效 token
    When 该 owner 高频地访问某 owner-only 端点超过公开端点的限额次数
    Then 这些请求不会因公开端点的限流被拒
    And 它们只受 owner 鉴权门约束

  Scenario: 探活端点不被限流
    When 对 GET /health 高频探活超过任何公开端点限额次数
    Then 每次都正常返回探活结果
    And 没有任何一次被限为 429

  Scenario: OPTIONS 预检不被限流触发
    Given 一个跨源前端对某限流公开端点反复发 OPTIONS 预检
    When 预检次数超过该端点的请求上限
    Then 每次预检都由 CORS 中间件以带 CORS 头的 2xx 短路应答
    And 没有任何一次预检被限流计数或被限为 429

  # --- 各端点限额（默认值，写进契约可调）--------------------------------------

  Scenario Outline: 各公开端点按各自默认限额限流
    Given 端点 "<端点>" 挂了限额为 "<限额>" 的限流
    When 某 IP 在对应窗口内的请求数超过该限额
    Then 超出的请求返回 429 并带 Retry-After

    Examples:
      | 端点                                  | 限额              |
      | POST /api/submit                      | 10/分钟 且 100/小时 |
      | POST /api/auth/register               | 5/小时            |
      | POST /api/auth/password-reset/request | 4/小时            |
      | POST /api/auth/login                  | 10/分钟           |
