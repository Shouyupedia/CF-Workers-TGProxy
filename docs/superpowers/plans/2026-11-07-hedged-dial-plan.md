# 实施计划：延迟启动备用上游连接

设计见 `docs/superpowers/specs/2026-11-07-hedged-dial-design.md`。每步都先写失败测试再实现。

1. 基线：运行 `npm test`，记录结果。
2. 配置：`mkCfg` 解析 `DIAL_HEDGE_MS` → `cfg.hedge`（默认 `CFG.hedgeMs`，范围 0..7500，进入缓存键）。
   - 单元测试：默认值、覆盖、钳制、缓存键。
3. `dial()` 单元测试（用 fake `fetch` + FakeWS，不触网）：
   - 首选快：只拨一个主机。
   - 首选超过 hedge 未成功：备用启动，先成功者胜出，另一个被 abort，且未 accept 为 wire、未收到任何写入。
   - 首选在 hedge 之前失败：立即启动备用（不等计时器）。
   - 两个同时成功：只保留一个，另一个 close。
   - 落选者在裁决后才成功：仍被 close。
   - stream signal 中止：全部候选 abort，dial 拒绝；之后迟到的连接也被 close。
   - 全部失败：dial 拒绝。
4. 实现 `connect()` / `dial()` / 参数传递，使 3 全绿。
5. 集成测试（Miniflare + kws-mock 新增 `/__ctl` 延迟/失败控制）：
   - 首选快：日志只有一条上游记录。
   - 首选慢：备用胜出，落选记录 `msgs === 0` 且无 header tag；总耗时远小于首选延迟。
   - 首选立即失败：备用立即启动，耗时小于 hedge。
   - 拨号期间客户端断开：两条上游记录都没有收到数据并最终关闭。
6. 全量 `npm test`。
7. 真实验证（`tests/real/`，手动运行）：
   - `probe-kws.mjs`：本机直连 `kws{1..5}[-1]`，测建连时间，发 `req_pq_multi` 收 `resPQ`。
   - `real-proxy.mjs`：Miniflare 不重定向出站，经 Worker 对真实 Telegram 发 `req_pq_multi` 收 `resPQ`；分别用默认 hedge 和 `DIAL_HEDGE_MS=0`。
8. README 补充 `DIAL_HEDGE_MS` 与行为说明。
