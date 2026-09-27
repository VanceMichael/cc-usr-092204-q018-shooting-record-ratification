// 全部时刻以 UTC 纳秒/毫秒时间戳在系统内流转，展示层再按赛区时区换算。
// 申诉窗口的"截止"以赛区本地钟点定义，跨时区发布必须与赛区本地时刻一致。

export function toMillis(instant) {
  if (instant instanceof Date) return instant.getTime();
  if (typeof instant === "number") return instant;
  if (typeof instant === "string") return Date.parse(instant);
  throw new Error(`无法解析时刻: ${String(instant)}`);
}

export function toIso(instant) {
  return new Date(toMillis(instant)).toISOString();
}

// 取某 UTC 时刻在给定 IANA 时区下的"墙钟"零件，用于窗口判定。
// 不引入第三方依赖：借助 Intl 拿到 yyyy/mm/dd/hh/min/ss。
function wallParts(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(toMillis(instant))).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "00" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function zonedDateTime(instant, timeZone) {
  const p = wallParts(instant, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

// 偏移分钟（含夏令时等历史规则），例如杭州 +480。
export function offsetMinutesAt(instant, timeZone) {
  const utc = wallParts(instant, "UTC");
  const local = wallParts(instant, timeZone);
  const utcMs = Date.UTC(utc.year, utc.month - 1, utc.day, utc.hour, utc.minute, utc.second);
  const localMs = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return Math.round((localMs - utcMs) / 60000);
}

export function formatOffset(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function formatInstant(instant, timeZone) {
  return `${zonedDateTime(instant, timeZone)}${formatOffset(offsetMinutesAt(instant, timeZone))}`;
}
