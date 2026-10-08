// 推送文案中英双语，LANG=en 切英文，缺省中文

export type Lang = "zh" | "en";

export function parseLang(raw: string | undefined | null): Lang {
  return (raw ?? "").trim().toLowerCase() === "en" ? "en" : "zh";
}

const zh = {
  alertTitle: (t: number) => `CF 账单告警：已超 $${t}`,
  alertBody: (money: string, detail: string) =>
    `当期累计 ${money}（${detail}）`,
  dailyTitle: (money: string) => `CF 账单日报 ${money}`,
  dailyBody: (
    detail: string,
    thresholds: string,
    triggered: string,
  ) =>
    `${detail}\n阈值 ${thresholds}${triggered ? `\n本次触发: ${triggered}` : ""}`,
  failTitle: "CF 账单监控失败",
  failBody: (e: string) => `本次检查异常: ${e}`,
  missingBark:
    "缺少 BARK_URL：请执行 npx wrangler secret put BARK_URL（值为 Bark 完整设备地址）",
  thresholds: (list: number[]) => list.map((t) => `$${t}`).join(" / "),
  triggered: (list: number[]) => list.map((t) => `$${t}`).join(", "),
  statusClosed: "已结清",
  statusOpen: "待付",
  spendDetail: (
    total: string,
    range: string,
    observed: number,
    days: number,
    avg: string,
    forecast: string,
    topLine: string,
  ) =>
    `当期累计 $${total}（${range}，已观察 ${observed}/${days} 天，日均 $${avg}，预计 $${forecast}）${topLine}`,
  topCosts: (items: string) => `\n主要成本: ${items}`,
  authError: (status: number) =>
    `Token 无 billing 权限 (status=${status})，请给 Token 加 Billing:Read`,
  historyEmpty: "账单历史为空或无金额字段",
  historyFallback: (total: string, day: string, status: string) =>
    `paygo 不可用，回退最新一期 $${total}（${day}，${status}，仅参考）`,
  spendFailed: (e: string) => `读取账单失败: ${e}`,
  spendUnknown: "账单接口均不可用，请看日志",
};

const en: typeof zh = {
  alertTitle: (t: number) => `CF Billing Alert: over $${t}`,
  alertBody: (money: string, detail: string) =>
    `Current period total ${money} (${detail})`,
  dailyTitle: (money: string) => `CF Billing Daily ${money}`,
  dailyBody: (
    detail: string,
    thresholds: string,
    triggered: string,
  ) =>
    `${detail}\nThresholds ${thresholds}${triggered ? `\nTriggered: ${triggered}` : ""}`,
  failTitle: "CF Billing Monitor Failed",
  failBody: (e: string) => `Check failed: ${e}`,
  missingBark:
    "Missing BARK_URL: run npx wrangler secret put BARK_URL (full Bark device URL)",
  thresholds: (list: number[]) => list.map((t) => `$${t}`).join(" / "),
  triggered: (list: number[]) => list.map((t) => `$${t}`).join(", "),
  statusClosed: "Closed",
  statusOpen: "Open",
  spendDetail: (
    total: string,
    range: string,
    observed: number,
    days: number,
    avg: string,
    forecast: string,
    topLine: string,
  ) =>
    `Period total $${total} (${range}, ${observed}/${days} days observed, avg $${avg}/day, projected $${forecast})${topLine}`,
  topCosts: (items: string) => `\nTop costs: ${items}`,
  authError: (status: number) =>
    `Token lacks billing permission (status=${status}); grant Billing:Read`,
  historyEmpty: "Billing history is empty or has no amount field",
  historyFallback: (total: string, day: string, status: string) =>
    `paygo unavailable, latest invoice $${total} (${day}, ${status}, for reference only)`,
  spendFailed: (e: string) => `Failed to read billing: ${e}`,
  spendUnknown: "Billing APIs unavailable, check logs",
};

export function msg(lang: Lang): typeof zh {
  return lang === "en" ? en : zh;
}
