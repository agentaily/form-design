---
"agentaily-forms": minor
---

bump `@agentaily/design-system` `^0.12.0 → ^0.13.0` —— 登录 / 注册页密码 + 确认密码框右下角即得显隐「小眼睛」（点击在密文/明文间切换，`tabIndex=-1` 不抢 Tab）。DS 0.13.0 给 `Input` 加了 opt-in `reveal` 并在内部 `SignInPage` 的密码字段开启；form-design `src/signin.jsx` wrap 了 DS `SignInPage`，纯 bump 即自动获得，零 signin 逻辑改动。上游 DS #33 / 0.13.0 reveal seam 的下游收尾。
