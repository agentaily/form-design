// Shared test helper for the entry guard (<AuthGate>, src/auth-gate.jsx).
//
// Since the designer mounts behind the page-level 未登录守卫, an outer-loop spec that
// renders <App> at a designer route must declare the owner's session through the gate's
// `checkSession` seam. These canned checks drive the three entry paths deterministically
// (no network mock): authed (→ designer), unauthed (→ in-place 登录视图), error (→ 重试占位).
//
// NOTE: the gate's resolved user does NOT seed the designer — the 未验证 banner still comes
// from the designer's own getCurrentUser/refreshMe seam — so `authedCheck()` is uniform and
// its user payload is irrelevant to banner specs (inject getCurrentUser separately for those).

/** authed → the designer mounts. The user payload is a placeholder (see NOTE above). */
export const authedCheck = async () => ({
  status: "authed",
  user: { email: "owner@example.com", emailVerified: true, displayName: null },
});

/** unauthed → the in-place 登录视图 (signed out / expired). */
export const unauthedCheck = async () => ({ status: "unauthed" });

/** error → the neutral 「重试 / 去登录」 placeholder (5xx / network). */
export const errorCheck = async () => ({ status: "error" });
