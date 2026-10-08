// Cloudflare 当前账单周期费用（实时）
//
// 数据源（2026-10 实测可用）：
// - GET /accounts/{id}/paygo-usage?from=..&to=..  FOCUS 格式逐日分产品记录，
//   每条带 EffectiveCost / BilledCost，求和即当期累计。
// - GET /accounts/{id}/paygo-usage-info  账单周期锚点（如每月 7 号）。
// 兜底：paygo 不可用时回退到 billing/history 最新一期账单。

import { msg, type Lang } from "./i18n";

export interface ServiceCost {
  name: string;
  cost: number;
}

export interface SpendResult {
  /** 当期累计（美元）；取不到时为 null */
  amount: number | null;
  /** 预计周期费用（按已观察天数外推） */
  forecast: number | null;
  /** 周期 key：起始日 YYYY-MM-DD（锚点对齐，非自然月） */
  period: string;
  source: string;
  detail: string;
}

const API = "https://api.cloudflare.com/client/v4";

async function cfGet(
  accountId: string,
  token: string,
  path: string,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${API}/accounts/${accountId}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))
    return Number(v);
  return null;
}

/** 从未知结构的 payload 里挖出记录数组 */
export function findRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    for (const k of ["records", "data", "rows", "result", "results", "usage"]) {
      const v = o[k];
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") {
        const inner = v as Record<string, unknown>;
        for (const k2 of ["records", "data", "rows"]) {
          if (Array.isArray(inner[k2])) return inner[k2] as unknown[];
        }
      }
    }
  }
  return [];
}

/** 从 paygo-usage-info 解析锚点日（如 7 号），失败返回 null */
export function anchorDayFromInfo(payload: unknown): number | null {
  const records = findRecords(payload);
  // info 的结构是 { result: { subscriptions: [...] } }，findRecords 挖不到，做一次直取
  const subs =
    payload &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>)["result"] &&
    typeof (payload as Record<string, unknown>)["result"] === "object"
      ? (
          (payload as Record<string, unknown>)["result"] as Record<
            string,
            unknown
          >
        )["subscriptions"]
      : null;
  const list = Array.isArray(subs) ? subs : records;
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const ts = (s as Record<string, unknown>)[
      "billing_cycle_anchor_timestamp"
    ];
    if (typeof ts === "string") {
      const d = new Date(ts);
      if (!Number.isNaN(d.getTime())) return d.getUTCDate();
    }
  }
  return null;
}

/** 按锚点日算当前周期 [from, to)，to 为下周期起点 */
export function currentPeriod(
  nowMs: number,
  anchorDay: number,
): { from: Date; to: Date } {
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const dim = (yy: number, mm: number) =>
    new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const clamp = (yy: number, mm: number) =>
    new Date(Date.UTC(yy, mm, Math.min(anchorDay, dim(yy, mm))));
  let from = clamp(y, m);
  if (from.getTime() > nowMs) {
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    from = clamp(py, pm);
  }
  const nm = from.getUTCMonth() === 11 ? 0 : from.getUTCMonth() + 1;
  const ny = from.getUTCMonth() === 11 ? from.getUTCFullYear() + 1 : from.getUTCFullYear();
  const to = clamp(ny, nm);
  return { from, to };
}

export function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function iso(d: Date): string {
  return d.toISOString();
}

/** 汇总 FOCUS 记录：总费用 + 按服务聚合（取 EffectiveCost，缺失取 BilledCost） */
export function sumPeriod(records: unknown[]): {
  total: number;
  top: ServiceCost[];
} {
  let total = 0;
  const byService = new Map<string, number>();
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) lower[k.toLowerCase()] = v;
    const cost =
      toNum(lower["effectivecost"]) ??
      toNum(lower["billedcost"]) ??
      toNum(lower["contractedcost"]) ??
      toNum(lower["listcost"]);
    if (cost === null) continue;
    total += cost;
    const name = String(
      o["ServiceName"] ?? o["serviceName"] ?? o["service"] ?? "unknown",
    );
    byService.set(name, (byService.get(name) ?? 0) + cost);
  }
  const top = [...byService.entries()]
    .map(([name, cost]) => ({ name, cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 3);
  return { total, top };
}

/** 预计周期费用 = 累计 / 已观察天数 * 周期天数 */
export function forecastTotal(
  total: number,
  observedDays: number,
  periodDays: number,
): number {
  if (observedDays < 1) observedDays = 1;
  return (total / observedDays) * periodDays;
}

async function getPaygoSpend(
  accountId: string,
  token: string,
  nowMs: number,
  lang: Lang,
): Promise<SpendResult | null> {
  // 1) 锚点（失败则回退每月 1 号）
  let anchorDay = 1;
  try {
    const info = await cfGet(accountId, token, "/paygo-usage-info");
    const d = info.status === 200 ? anchorDayFromInfo(info.json) : null;
    if (d !== null) anchorDay = d;
  } catch (e) {
    console.log(`[spend] info error: ${String(e)}`);
  }
  const { from, to } = currentPeriod(nowMs, anchorDay);
  const periodDays = Math.max(
    1,
    Math.round((to.getTime() - from.getTime()) / 86400_000),
  );
  const observedDays = Math.max(
    1,
    Math.min(
      periodDays,
      Math.floor((Math.min(nowMs, to.getTime()) - from.getTime()) / 86400_000) + 1,
    ),
  );

  // 2) 当期明细
  const { status, json } = await cfGet(
    accountId,
    token,
    `/paygo-usage?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}`,
  );
  console.log(`[spend] paygo status=${status} anchor=${anchorDay}`);
  if (status === 401 || status === 403) return null;
  if (status !== 200) return null;
  const records = findRecords(json);
  const { total, top } = sumPeriod(records);
  const forecast = forecastTotal(total, observedDays, periodDays);
  const range = `${fmtDay(from).slice(5)}~${fmtDay(new Date(to.getTime() - 1)).slice(5)}`;
  const t = msg(lang);
  const topLine =
    total > 0 && top.length > 0
      ? t.topCosts(top.map((s) => `${s.name.split(" (")[0]} $${s.cost.toFixed(2)}`).join(" / "))
      : "";
  return {
    amount: total,
    forecast,
    period: fmtDay(from),
    source: "paygo-usage",
    detail: t.spendDetail(
      total.toFixed(2),
      range,
      observedDays,
      periodDays,
      (total / observedDays).toFixed(2),
      forecast.toFixed(2),
      topLine,
    ),
  };
}

/** 兜底：billing/history 最新一期账单 */
async function getHistorySpend(
  accountId: string,
  token: string,
  lang: Lang,
): Promise<SpendResult | null> {
  const t = msg(lang);
  try {
    const { status, json } = await cfGet(
      accountId,
      token,
      "/billing/history?per_page=5",
    );
    if (status !== 200) return null;
    const records = findRecords(json);
    const inv = records
      .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : null))
      .filter((o) => o && (toNum(o["amount_to_pay"]) ?? toNum(o["amount"])) !== null)
      .sort((a, b) =>
        String(a?.["occurred_at"] ?? "") < String(b?.["occurred_at"] ?? "") ? 1 : -1,
      )[0];
    if (!inv) return null;
    const amount =
      toNum(inv["amount_to_pay"]) ?? toNum(inv["amount"]) ?? 0;
    const day = String(inv["occurred_at"] ?? "").slice(0, 10);
    const rawStatus = String(inv["status"] ?? "");
    const label =
      rawStatus === "CLOSED"
        ? t.statusClosed
        : rawStatus === "OPEN"
          ? t.statusOpen
          : rawStatus;
    return {
      amount,
      forecast: null,
      period: day.slice(0, 7),
      source: "billing-history",
      detail: t.historyFallback(amount.toFixed(2), day, label),
    };
  } catch (e) {
    console.log(`[spend] history error: ${String(e)}`);
    return null;
  }
}

export async function getSpend(
  accountId: string,
  token: string,
  nowMs: number = Date.now(),
  lang: Lang = "zh",
): Promise<SpendResult> {
  const t = msg(lang);
  const paygo = await getPaygoSpend(accountId, token, nowMs, lang).catch((e) => {
    console.log(`[spend] paygo error: ${String(e)}`);
    return null;
  });
  if (paygo) return paygo;
  const hist = await getHistorySpend(accountId, token, lang);
  if (hist) return hist;
  return {
    amount: null,
    forecast: null,
    period: "",
    source: "unknown",
    detail: t.spendUnknown,
  };
}
