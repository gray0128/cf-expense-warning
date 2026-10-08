# cf-expense-warning

Cloudflare Worker 定时统计**当前账单周期**费用，超阈值自动预警，全部经 Bark 推送到手机。

- 周期日报：按配置频率推送当期累计 / 日均 / 预计周期费用（默认每天）
- 阈值告警：当期累计超过阈值时，每个阈值告警一次（默认 `$1 / $5 / $10`），每账单周期自动重置
- 全部可配置：阈值金额、检查频率、推送频率、推送语言（中文缺省）、Bark 链接

## 推送通道：Bark

通知经 [Bark](https://github.com/Finb/Bark) 推送，需配合 Bark 服务端使用。
服务端可自建（见 [bark-server](https://github.com/Finb/bark-server)，支持 Docker / 二进制部署），
手机端安装 Bark App 后扫码绑定即得设备 key。

Worker 要的只是一个**完整设备地址**，形如：

```text
https://<你的 Bark 域名>/<设备 key>
```

Bark 推送示例（与 Worker 实际发送的格式一致）：

```sh
curl -X POST "https://<你的 Bark 域名>/<设备 key>" \
  -H "Content-Type: application/json" \
  -d '{"title":"CF 账单日报 $0.00","body":"...","group":"cf-expense"}'
```

该地址只通过 secret / 本地 `.dev.vars` 注入，**不要提交到仓库**。

## 配置项

| 需求 | 在哪里改 |
|---|---|
| 阈值金额 | `wrangler.jsonc` → `vars.THRESHOLDS`（如 `"1,5,10"`） |
| 检查频率 | `wrangler.jsonc` → `triggers.crons`（改完重新 deploy，如每小时 `"0 * * * *"`） |
| 周期推送频率 | `wrangler.jsonc` → `vars.REPORT_INTERVAL_HOURS`（`24`=每天） |
| 推送语言 | `wrangler.jsonc` → `vars.LANG`（`zh`缺省 / `en`英文） |
| Bark 链接 | secret `BARK_URL`（完整设备地址）；本地填 `.dev.vars`，线上 `npx wrangler secret put BARK_URL` |
| Bark 分组 | `wrangler.jsonc` → `vars.BARK_GROUP` |

去重语义：阈值告警 key 为 `alert:<周期起始日>:<阈值>`（周期按账单锚点对齐，如 `alert:2026-10-07:5`），
新周期自动重置；周期推送按 `report:lastAt` 时间戳节流。

## 上线步骤（本机 `cf` + `wrangler`）

1. 建 API Token（Dashboard → My Profile → API Tokens → Create），权限至少 `Account - Billing - Read`。
   注意：`cf auth login` 的 OAuth 没有 billing 权限，探接口必须用这个 Token。
2. 本机探通（确认 Token 能读到费用数据再部署）：
   ```sh
   curl -s -H "Authorization: Bearer <token>" \
     "https://api.cloudflare.com/client/v4/accounts/<account_id>/paygo-usage?from=2026-10-07T00:00:00.000Z&to=2026-11-07T00:00:00.000Z" \
     | head -c 300
   ```
   返回 FOCUS 记录（含 `BilledCost`）即正常；`1171 insufficient_permissions` 说明权限不对。
3. 登录 wrangler（`cf auth login` 和 wrangler 不共用认证，需单独登一次）：
   ```sh
   npx wrangler login
   ```
4. 建 KV 并填 id：
   ```sh
   npx wrangler kv namespace create STATE
   # 把返回的 id 填进 wrangler.jsonc 的 kv_namespaces
   ```
5. 设 secrets：
   ```sh
   npx wrangler secret put CF_API_TOKEN   # 第 1 步的 Token
   npx wrangler secret put CF_ACCOUNT_ID  # 账户 ID
   npx wrangler secret put BARK_URL       # 必需，Bark 完整设备地址
   npx wrangler secret put MANUAL_KEY     # 可选，手动触发口令
   ```
6. 部署并手动触发一次验证：
   ```sh
   npm run deploy
   curl "https://<worker>.workers.dev/trigger?key=<MANUAL_KEY>"
   ```
   手机 Bark 应收到日报；返回 JSON 里 `amount` / `forecast` / `source` 即当期数据。
   若当天已推过日报（`reportSent:false`），清掉重验：
   ```sh
   npx wrangler kv key delete --binding STATE "report:lastAt" --remote
   ```

## 金额来源（当前周期实时费用）

与 dashboard“可计费使用量”页同源：

* `GET /accounts/{id}/paygo-usage?from=..&to=..` —— 当期逐日分产品费用（FOCUS 格式），
  求和即当期累计；除以已观察天数 × 周期天数即预计周期费用。
* `GET /accounts/{id}/paygo-usage-info` —— 账单周期锚点（如每月 7 号），周期区间与去重都按它对齐。
* 兜底：paygo 不可用时回退 `billing/history` 最新一期账单。

注意：用量接口（`billable/usage` v2、`billable-usage` v1）是 Restricted Alpha，
标准 `Billing:Read` 会回 `1171 insufficient_permissions`，不要用。

## 换账号适配

周期锚点是每次运行动态读取的，换账号只需更新 `CF_API_TOKEN` + `CF_ACCOUNT_ID` 两个 secret
（Token 权限同样 `Billing:Read`），调一次 `/trigger` 验证通过即适配。
多订阅各有锚点的账号看日志 `[spend] paygo status=... anchor=...` 确认。

## 本地开发

```sh
cp .dev.vars.example .dev.vars   # 填真实值（已 gitignore）
npm run dev                       # wrangler dev
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+1+*+*+*"
npm run check && npm test
```

## 目录结构

```text
src/
  index.ts    scheduled/fetch 入口，阈值 + 日报编排，KV 去重
  billing.ts  paygo-usage 周期费用统计（锚点/汇总/预测）+ history 兜底
  logic.ts    纯函数：阈值解析 / 周期计算 / 触发判断
  i18n.ts     推送文案中英双语
  notify.ts   Bark 推送
test/
  run.mjs     单元测试（esbuild 打包后跑断言）
```
