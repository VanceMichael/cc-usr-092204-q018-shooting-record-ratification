import { badRequest } from "./errors.js";

/**
 * 竞赛版本：同一场资格赛在报名时被固定到某一个版本，
 * 之后所有分项/总环计算、申诉窗口都按该版本执行，互不串用。
 */
export const RULESETS = {
  "issf-ar60-2022": {
    id: "issf-ar60-2022",
    label: "10米气步枪资格赛 60 发（2022 竞赛版）",
    seriesCount: 6,
    shotsPerSeries: 10,
    maxShotValue: 10.9,
    teamSize: 3,
    appealWindowMinutes: 20,
  },
  "issf-ar60-2024": {
    id: "issf-ar60-2024",
    label: "10米气步枪资格赛 60 发（2024 竞赛版）",
    seriesCount: 6,
    shotsPerSeries: 10,
    maxShotValue: 10.9,
    teamSize: 3,
    appealWindowMinutes: 30,
  },
};

export function getRuleset(id) {
  const ruleset = RULESETS[id];
  if (!ruleset) throw badRequest(`未知竞赛版本: ${id}`);
  return ruleset;
}

/** 十米气步枪决赛阶段计环：0.0 – 10.9，最小刻度 0.1。 */
export function assertShotValue(ruleset, value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw badRequest("环值必须是数字");
  }
  if (value < 0 || value > ruleset.maxShotValue) {
    throw badRequest(`环值超出范围 0 – ${ruleset.maxShotValue}: ${value}`);
  }
  if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) {
    throw badRequest(`环值最小刻度为 0.1: ${value}`);
  }
}

/** 一位小数求和，消除浮点误差。 */
export function round1(value) {
  return Math.round(value * 10) / 10;
}
