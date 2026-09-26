import { ShootingService } from "../src/service.js";

/** 可推进的测试时钟：所有截止时间断言都显式控制。 */
export function makeHarness() {
  let now = Date.parse("2026-09-26T08:00:00.000Z");
  const service = new ShootingService({ clock: () => new Date(now).toISOString() });
  return {
    service,
    advance(minutes) {
      now += minutes * 60_000;
    },
    now: () => new Date(now).toISOString(),
  };
}

export const OFFICIAL = { officialId: "ref-01", signature: "sig-ref-01" };

export function registerMatch(service, overrides = {}) {
  return service.registerMatch({
    matchId: "match-1",
    rulesetId: "issf-ar60-2024",
    discipline: "10m-air-rifle",
    category: "women",
    recordLevels: ["ASIAN"],
    venueZone: "Asia/Shanghai",
    scheduledStartUtc: "2026-09-26T09:00:00.000Z",
    ...overrides,
  });
}

export function enterAthlete(service, athleteId, teamId = null) {
  return service.enterAthlete("match-1", {
    athleteId,
    displayName: `选手-${athleteId}`,
    teamId,
    personal: { idNumber: `ID-${athleteId}`, dob: "2001-01-01" },
    equipment: { make: "Walther", model: "LG400", serial: `SN-${athleteId}` },
  });
}

/** 636.8：60 发中 8 发 10.7、52 发 10.6。 */
export function card636_8() {
  const values = Array(60).fill(10.6);
  for (let i = 0; i < 8; i += 1) values[i] = 10.7;
  return values;
}

/** 规律分布：每组 104.5，总计 627.0。 */
export function card627() {
  return Array.from({ length: 60 }, (_, i) => 10 + ((i * 7) % 10) / 10);
}

export function recordCard(service, athleteId, values, targetId = `T-${athleteId}`) {
  values.forEach((value, index) => {
    service.recordShot("match-1", {
      athleteId,
      targetId,
      series: Math.floor(index / 10) + 1,
      shot: (index % 10) + 1,
      value,
      firedAtUtc: "2026-09-26T09:30:00.000Z",
      device: { id: `DEV-${targetId}`, clockOffsetMs: 3 },
    });
  });
}

/** 搭建一场七人比赛：CHN/KOR 两队各三人，C1 个人。 */
export function setupMatch(service) {
  registerMatch(service);
  for (const id of ["A1", "A2", "A3"]) enterAthlete(service, id, "CHN");
  for (const id of ["B1", "B2", "B3"]) enterAthlete(service, id, "KOR");
  enterAthlete(service, "C1", null);
  recordCard(service, "A1", card636_8());
  for (const id of ["A2", "A3", "B1", "B2", "B3"]) recordCard(service, id, card627());
  recordCard(service, "C1", Array(60).fill(9.5));
}
