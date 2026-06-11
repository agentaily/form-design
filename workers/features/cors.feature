Feature: CORS 跨源访问控制 覆盖所有 /api/* 端点
  作为运行在 form-design.agentaily.com 的前端
  我想让浏览器对后端 API 的跨源请求（带 Authorization 与 JSON body）通过预检并拿到正确的 CORS 响应头
  以便前端能正常调用后端，而后端只对白名单来源开放、不退化成任意来源可调

  背景：前端（CF Pages）与后端 API（Workers）不同源，浏览器对带自定义头的跨源请求会先发 OPTIONS 预检。
  后端用 Hono 内置 cors 中间件，对所有 /api/* 统一附加 Access-Control-* 头并应答预检。
  允许的来源是一份白名单（生产 https://form-design.agentaily.com 与本地 http://localhost:5173），
  不退化成 *；允许方法 GET/POST/PATCH/DELETE/OPTIONS、允许头 Authorization 与 Content-Type；
  不开启 credentials（token 走 Authorization 头而非 cookie）。CORS 中间件在 owner-only 鉴权之前生效，
  使预检的 OPTIONS（不带 token）也能被正确应答、不被 401 拦掉。

  Scenario: 白名单来源对公开端点的预检得到 CORS 头
    Given 一个 Origin 为生产前端域名的请求
    When 浏览器对 /api/submit 发起 OPTIONS 预检
    Then 响应状态码为 2xx
    And 响应头 Access-Control-Allow-Origin 回显该白名单来源
    And 响应头 Access-Control-Allow-Methods 含 GET、POST、PATCH、DELETE
    And 响应头 Access-Control-Allow-Headers 含 Authorization 与 Content-Type

  Scenario: 本地 dev 来源也在白名单内
    Given 一个 Origin 为本地 dev 地址的请求
    When 浏览器对 /api/forms 发起 OPTIONS 预检
    Then 响应状态码为 2xx
    And 响应头 Access-Control-Allow-Origin 回显该本地 dev 来源

  Scenario: owner-only 端点的预检无需 token 即返回 CORS 头
    Given 一个 Origin 为生产前端域名的请求
    When 浏览器对 owner-only 端点发起不带 Authorization 的 OPTIONS 预检
    Then 响应状态码为 2xx
    And 响应头带有 Access-Control-Allow-Origin
    And 该预检没有被鉴权拦成 401

  Scenario: 白名单来源对实际请求的响应带 CORS 头
    Given 一个 Origin 为生产前端域名的请求
    And 一份已发布的表单
    When 答题者从该来源无鉴权地拉取该 slug 对应的表单
    Then 响应状态码为 200
    And 响应头 Access-Control-Allow-Origin 回显该白名单来源

  Scenario: 非白名单来源不被回显为允许来源
    Given 一个 Origin 为非白名单域名的请求
    When 浏览器从该来源对 /api/submit 发起 OPTIONS 预检
    Then 响应头 Access-Control-Allow-Origin 不等于该非白名单来源
    And 响应头 Access-Control-Allow-Origin 不是通配符 星号

  Scenario: 不开启凭据模式
    Given 一个 Origin 为生产前端域名的请求
    When 浏览器对 /api/config 发起 OPTIONS 预检
    Then 响应里不包含 Access-Control-Allow-Credentials 为真
