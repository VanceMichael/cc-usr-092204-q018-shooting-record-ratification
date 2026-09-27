// 环值与小项规则。射击计分精度为 0.1 环（十分位制）：
// 弹着点到靶心的距离按靶纸环带换算为整数环，再按子环带叠加 0.0–0.9。
// 全程用"十分之一环"整数运算，避免浮点误差（10.9 环 = 109）。

export const INNER_TEN_MIN = 100; // 整 10.0 环（含）以上进入内十环计数
export const MAX_DECIMAL_RING = 109; // 10.9 环

// 规则版本：计分口径以"竞赛版本"为准。规程修订不会改写历史版本的计算结果。
// effectiveFrom 为 UTC，赛事时刻落在区间内即选用该版本。
export const RULE_VERSIONS = {
  "ISSF-RIFLE-2022": {
    ruleVersion: "ISSF-RIFLE-2022",
    discipline: "RIFLE",
    name: "ISSF 步枪技术规则 2022 版（十分位计分）",
    effectiveFrom: "2022-01-01T00:00:00Z",
    seriesCount: 6, // 女子 10 米气步枪资格赛 6 个系列
    shotsPerSeries: 10, // 每系列 10 发
    maxShot: 109, // 单发上限 10.9
    decimalScoring: true,
  },
};

export function resolveRuleVersion(ruleVersion, atUtc) {
  const rule = RULE_VERSIONS[ruleVersion];
  if (!rule) throw new Error(`未知竞赛版本: ${ruleVersion}`);
  if (atUtc && atUtc < rule.effectiveFrom) {
    throw new Error(`竞赛版本 ${ruleVersion} 在 ${atUtc} 尚未生效`);
  }
  return rule;
}

// 原始读数 -> 十分之一环整数。电子靶上送整数 tenths；
// 兼容一位小数的字符串/数字输入。单发合法区间 0.0–10.9（脱靶 0 环）。
export function toTenths(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value < 0 || value > MAX_DECIMAL_RING) throw new Error(`单发环值越界: ${value}`);
    return value;
  }
  if (typeof value === "number") {
    const tenths = Math.round(value * 10);
    if (tenths < 0 || tenths > MAX_DECIMAL_RING) throw new Error(`单发环值越界: ${value}`);
    return tenths;
  }
  if (typeof value === "string" && /^\d{1,2}(\.\d)?$/.test(value)) {
    const tenths = Math.round(Number(value) * 10);
    if (tenths > MAX_DECIMAL_RING) throw new Error(`单发环值越界: ${value}`);
    return tenths;
  }
  throw new Error(`无法解析环值: ${String(value)}`);
}

// 总环/扣分类十分位值：无单发上限（60 发总环可达 654.0 = 6540）。
export function toTotalTenths(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value < 0) throw new Error(`环值不能为负: ${value}`);
    return value;
  }
  if (typeof value === "number") return Math.round(value * 10);
  if (typeof value === "string" && /^\d{1,4}(\.\d)?$/.test(value)) {
    return Math.round(Number(value) * 10);
  }
  throw new Error(`无法解析总环值: ${String(value)}`);
}

export function formatRing(tenths) {
  return (tenths / 10).toFixed(1);
}

export function formatTotal(tenths) {
  return (tenths / 10).toFixed(1);
}
