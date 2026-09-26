import { badRequest } from "./errors.js";

/** 当前 UTC 瞬间，ISO 8601 字符串。 */
export function utcNow() {
  return new Date().toISOString();
}

/** 解析并规范化为 UTC ISO 字符串；非法输入抛出领域错误。 */
export function parseInstant(iso, field = "instant") {
  if (typeof iso !== "string" || iso.length === 0) {
    throw badRequest(`${field} 必须是 ISO 8601 字符串`);
  }
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) {
    throw badRequest(`${field} 不是可解析的时间: ${iso}`);
  }
  return time.toISOString();
}

export function addMinutes(iso, minutes) {
  return new Date(new Date(parseInstant(iso)).getTime() + minutes * 60_000).toISOString();
}

/** a 是否严格晚于 b（均为 ISO 字符串）。 */
export function isAfter(a, b) {
  return new Date(parseInstant(a, "a")) > new Date(parseInstant(b, "b"));
}

/** 校验 IANA 时区名是否可用。 */
export function assertZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw badRequest(`未知时区: ${zone}`);
  }
  return zone;
}

/** 把 UTC 瞬间格式化为指定时区的本地时间文本，用于跨时区发布。 */
export function inZone(iso, zone) {
  assertZone(zone);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    dateStyle: "medium",
    timeStyle: "long",
    hour12: false,
  }).format(new Date(parseInstant(iso)));
}

/** 申诉截止时间 = 正式确认时刻 + 竞赛版本规定的窗口分钟数。 */
export function appealDeadline(officialAtUtc, windowMinutes) {
  return addMinutes(officialAtUtc, windowMinutes);
}
