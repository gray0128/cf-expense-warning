// 用法: npm test  （用 esbuild 打包纯逻辑后跑断言，不依赖线上 API）
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outdir = mkdtempSync(join(tmpdir(), "cfew-"));
execSync(`npx esbuild src/logic.ts src/billing.ts src/i18n.ts --bundle --format=esm --outdir=${outdir} --log-level=error`, {
  stdio: "inherit",
});

const logic = await import(join(outdir, "logic.js"));
const billing = await import(join(outdir, "billing.js"));

// parseThresholds
assert.deepEqual(logic.parseThresholds("1,5,10"), [1, 5, 10]);
assert.deepEqual(logic.parseThresholds("10,1,5,1"), [1, 5, 10]);
assert.deepEqual(logic.parseThresholds(" 5 , 1 ,x,-3,0,"), [1, 5]);
assert.deepEqual(logic.parseThresholds(""), [1, 5, 10]);
assert.deepEqual(logic.parseThresholds(undefined), [1, 5, 10]);
assert.deepEqual(logic.parseThresholds("abc"), [1, 5, 10]);

// periodKey
assert.equal(logic.periodKey(new Date("2026-10-08T00:00:00Z")), "2026-10");
assert.equal(logic.periodKey(new Date("2026-01-05T00:00:00Z")), "2026-01");

// newlyCrossed：每个阈值只触发一次由调用方 KV 保证，这里只判集合差
assert.deepEqual(logic.newlyCrossed(0.5, [1, 5, 10], new Set()), []);
assert.deepEqual(logic.newlyCrossed(1, [1, 5, 10], new Set()), [1]);
assert.deepEqual(logic.newlyCrossed(5.5, [1, 5, 10], new Set([1])), [5]);
assert.deepEqual(logic.newlyCrossed(12, [1, 5, 10], new Set()), [1, 5, 10]);
assert.deepEqual(logic.newlyCrossed(12, [1, 5, 10], new Set([1, 5, 10])), []);

// shouldReport
const H = 3600_000;
const now = Date.UTC(2026, 9, 8, 1, 0, 0);
assert.equal(logic.shouldReport(null, now, 24), true);
assert.equal(logic.shouldReport(now - 25 * H, now, 24), true);
assert.equal(logic.shouldReport(now - 24 * H, now, 24), true);
assert.equal(logic.shouldReport(now - 1 * H, now, 24), false);
assert.equal(logic.shouldReport(null, now, 0), false);

// parseIntervalHours
assert.equal(logic.parseIntervalHours("24"), 24);
assert.equal(logic.parseIntervalHours("6"), 6);
assert.equal(logic.parseIntervalHours("abc"), 24);
assert.equal(logic.parseIntervalHours(""), 24);

// anchorDayFromInfo: 真实 paygo-usage-info 结构
assert.equal(
  billing.anchorDayFromInfo({
    result: {
      subscriptions: [
        { billing_cycle_anchor_timestamp: "2024-04-07T00:00:00Z" },
      ],
    },
  }),
  7,
);
assert.equal(billing.anchorDayFromInfo({}), null);

// currentPeriod: 锚点 7 号
let p = billing.currentPeriod(Date.UTC(2026, 9, 8, 1), 7); // 10-08
assert.equal(p.from.toISOString().slice(0, 10), "2026-10-07");
assert.equal(p.to.toISOString().slice(0, 10), "2026-11-07");
p = billing.currentPeriod(Date.UTC(2026, 9, 5, 1), 7); // 10-05，还在上周期
assert.equal(p.from.toISOString().slice(0, 10), "2026-09-07");
assert.equal(p.to.toISOString().slice(0, 10), "2026-10-07");
p = billing.currentPeriod(Date.UTC(2026, 0, 3, 1), 7); // 01-03，跨年
assert.equal(p.from.toISOString().slice(0, 10), "2025-12-07");
assert.equal(p.to.toISOString().slice(0, 10), "2026-01-07");
p = billing.currentPeriod(Date.UTC(2026, 9, 7, 0, 0, 0), 7); // 锚点当天 00:00
assert.equal(p.from.toISOString().slice(0, 10), "2026-10-07");

// sumPeriod: FOCUS 记录求和 + Top 服务
const focus = [
  { ServiceName: "D1 - Rows Read (first 25 billion included)", EffectiveCost: 0, BilledCost: 0, ConsumedQuantity: 182090 },
  { ServiceName: "Workers - Requests", EffectiveCost: "1.25", ConsumedQuantity: 100 },
  { ServiceName: "Workers - Duration", BilledCost: 2.5 },
  { ServiceName: "NoCost", ConsumedQuantity: 5 },
];
const summed = billing.sumPeriod(focus);
assert.equal(summed.total, 3.75);
assert.equal(summed.top[0].name, "Workers - Duration");
assert.equal(summed.top[0].cost, 2.5);
assert.equal(billing.sumPeriod([]).total, 0);

// forecastTotal
assert.equal(billing.forecastTotal(0, 2, 31), 0);
assert.equal(billing.forecastTotal(10, 10, 30), 30);

// i18n: 缺省中文，LANG=en 切英文
const i18n = await import(join(outdir, "i18n.js"));
assert.equal(i18n.parseLang(undefined), "zh");
assert.equal(i18n.parseLang(""), "zh");
assert.equal(i18n.parseLang("en"), "en");
assert.equal(i18n.parseLang("EN"), "en");
assert.equal(i18n.parseLang("zh"), "zh");
assert.equal(i18n.msg("zh").dailyTitle("$0.00"), "CF 账单日报 $0.00");
assert.equal(i18n.msg("en").dailyTitle("$0.00"), "CF Billing Daily $0.00");
assert.equal(i18n.msg("zh").alertTitle(5), "CF 账单告警：已超 $5");
assert.equal(i18n.msg("en").alertTitle(5), "CF Billing Alert: over $5");
assert.ok(i18n.msg("en").spendDetail("0.00", "10-07~11-06", 2, 31, "0.00", "0.00", "").includes("Period total"));
assert.ok(i18n.msg("zh").spendDetail("0.00", "10-07~11-06", 2, 31, "0.00", "0.00", "").includes("当期累计"));

// findRecords: 兼容多种包壳
assert.equal(billing.findRecords([{ a: 1 }]).length, 1);
assert.equal(billing.findRecords({ result: [{ a: 1 }] }).length, 1);
assert.equal(billing.findRecords({ result: { records: [{ a: 1 }] } }).length, 1);
assert.equal(billing.findRecords({ data: [{ a: 1 }] }).length, 1);
assert.equal(billing.findRecords({}).length, 0);

console.log("all tests passed");
