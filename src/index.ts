import { getSpend } from "./billing";
import { msg, parseLang } from "./i18n";
import {
  newlyCrossed,
  parseIntervalHours,
  parseThresholds,
  periodKey,
  shouldReport,
} from "./logic";
import { sendBark } from "./notify";

export interface Env {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  BARK_URL: string;
  BARK_GROUP?: string;
  THRESHOLDS?: string; // "1,5,10"
  REPORT_INTERVAL_HOURS?: string; // "24"
  LANG?: string; // "zh"（缺省）/ "en"
  MANUAL_KEY?: string;
  STATE: KVNamespace;
}

export interface CheckSummary {
  ok: boolean;
  period: string;
  amount: number | null;
  forecast: number | null;
  source: string;
  detail: string;
  alertsSent: number[];
  reportSent: boolean;
  error?: string;
}

const ALERT_TTL = 62 * 86400; // 阈值标记保留 62 天，跨周期自动失效兜底

async function runCheck(env: Env, nowMs: number): Promise<CheckSummary> {
  const lang = parseLang(env.LANG);
  const m = msg(lang);
  // Bark 链接可配置：通过 secret/变量 BARK_URL 注入（完整设备地址，如 https://host/<key>）
  if (!env.BARK_URL || !env.BARK_URL.trim()) throw new Error(m.missingBark);
  const thresholds = parseThresholds(env.THRESHOLDS);
  const intervalHours = parseIntervalHours(env.REPORT_INTERVAL_HOURS);
  const group = env.BARK_GROUP || "cf-expense";

  const spend = await getSpend(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, nowMs, lang);
  const amount = spend.amount;
  // 周期 key 用账单锚点对齐的起始日（如 2026-10-07），非自然月
  const period = spend.period || periodKey(new Date(nowMs));
  const money = amount === null ? (lang === "en" ? "unknown" : "未知") : `$${amount.toFixed(2)}`;

  // 1) 阈值告警：每个账单周期内，每个阈值只通知一次
  const alertsSent: number[] = [];
  if (amount !== null) {
    const keys = await Promise.all(
      thresholds.map((t) => env.STATE.get(`alert:${period}:${t}`)),
    );
    const alerted = new Set<number>();
    thresholds.forEach((t, i) => {
      if (keys[i]) alerted.add(t);
    });
    for (const th of newlyCrossed(amount, thresholds, alerted)) {
      await sendBark(env.BARK_URL, {
        title: m.alertTitle(th),
        body: m.alertBody(money, spend.detail),
        group,
      });
      await env.STATE.put(`alert:${period}:${th}`, "1", {
        expirationTtl: ALERT_TTL,
      });
      alertsSent.push(th);
    }
  }

  // 2) 周期推送：按 REPORT_INTERVAL_HOURS 频率推送一次账单
  let reportSent = false;
  const lastRaw = await env.STATE.get("report:lastAt");
  const lastAt = lastRaw === null ? null : Number(lastRaw);
  if (shouldReport(Number.isFinite(lastAt) ? (lastAt as number) : null, nowMs, intervalHours)) {
    await sendBark(env.BARK_URL, {
      title: m.dailyTitle(money),
      body: m.dailyBody(spend.detail, m.thresholds(thresholds), m.triggered(alertsSent)),
      group,
    });
    await env.STATE.put("report:lastAt", String(nowMs));
    reportSent = true;
  }

  return {
    ok: true,
    period,
    amount,
    forecast: spend.forecast,
    source: spend.source,
    detail: spend.detail,
    alertsSent,
    reportSent,
  };
}

export default {
  // Cron 定时触发（频率在 wrangler.jsonc 的 triggers.crons 配置）
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const s = await runCheck(env, event.scheduledTime);
          console.log(`[check] ok period=${s.period} amount=${s.amount} alerts=${s.alertsSent.join(",")} report=${s.reportSent}`);
        } catch (e) {
          console.log(`[check] failed: ${String(e)}`);
          const fm = msg(parseLang(env.LANG));
          try {
            await sendBark(env.BARK_URL, {
              title: fm.failTitle,
              body: fm.failBody(String(e)),
              group: env.BARK_GROUP || "cf-expense",
            });
          } catch {
            // bark 也挂了，只能记日志
          }
          throw e;
        }
      })(),
    );
  },

  // HTTP：/ 健康检查；/trigger?key= 手动触发一次（需 MANUAL_KEY）
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/trigger") {
      if (!env.MANUAL_KEY || url.searchParams.get("key") !== env.MANUAL_KEY)
        return new Response("not found", { status: 404 });
      try {
        const s = await runCheck(env, Date.now());
        return Response.json(s);
      } catch (e) {
        return Response.json(
          { ok: false, error: String(e) },
          { status: 500 },
        );
      }
    }
    return Response.json({
      ok: true,
      name: "cf-expense-warning",
      lang: parseLang(env.LANG),
      thresholds: parseThresholds(env.THRESHOLDS),
      reportIntervalHours: parseIntervalHours(env.REPORT_INTERVAL_HOURS),
    });
  },
};
