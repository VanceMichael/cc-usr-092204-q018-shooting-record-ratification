import test from "node:test";
import assert from "node:assert/strict";
import { addMinutes, appealDeadline, inZone, isAfter } from "../src/domain/time.js";
import { OFFICIAL, makeHarness, setupMatch } from "./helpers.js";

test("运动员隐私与器材细节按角色开放", () => {
  const { service } = makeHarness();
  setupMatch(service);

  const audience = service.scorecard("match-1", "A1", "audience");
  assert.equal(audience.athlete.personal, undefined);
  assert.equal(audience.athlete.equipment, undefined);
  assert.equal(audience.shots, undefined); // 观众看分项与总环，不看每发设备数据
  assert.equal(audience.official, undefined); // 裁判签名不公开

  const referee = service.scorecard("match-1", "A1", "referee");
  assert.equal(referee.athlete.personal, undefined); // 证件号等隐私不对裁判开放
  assert.deepEqual(referee.athlete.equipment, { make: "Walther", model: "LG400" });
  assert.equal(referee.shots.length, 60);
  assert.equal(referee.shots[0].deviceId, undefined); // 设备内部细节裁判不可见

  const td = service.scorecard("match-1", "A1", "technical_delegate");
  assert.equal(td.athlete.personal.idNumber, "ID-A1");
  assert.equal(td.athlete.equipment.serial, "SN-A1");
  assert.equal(td.shots[0].deviceId, "DEV-T-A1");
  assert.equal(td.shots[0].deviceClockOffsetMs, 3);
});

test("未知角色被拒绝", () => {
  const { service } = makeHarness();
  setupMatch(service);
  assert.throws(() => service.scorecard("match-1", "A1", "root"), /未知角色/);
});

test("跨时区发布：UTC 存储，按指定时区显示", () => {
  const iso = "2026-09-26T08:00:00.000Z";
  assert.ok(inZone(iso, "Asia/Shanghai").includes("16:00"));
  assert.ok(inZone(iso, "UTC").includes("08:00"));
  assert.throws(() => inZone(iso, "Mars/Olympus"), /未知时区/);
});

test("申诉截止按竞赛版本窗口精确计算", () => {
  const officialAt = "2026-09-26T10:00:00.000Z";
  assert.equal(appealDeadline(officialAt, 30), "2026-09-26T10:30:00.000Z");
  assert.equal(addMinutes(officialAt, 31), "2026-09-26T10:31:00.000Z");
  assert.equal(isAfter("2026-09-26T10:31:00.000Z", appealDeadline(officialAt, 30)), true);
  assert.equal(isAfter("2026-09-26T10:29:00.000Z", appealDeadline(officialAt, 30)), false);
});

test("观众时间线呈现清晰状态与本地化截止时间", () => {
  const { service } = makeHarness();
  setupMatch(service);
  service.reviewScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });
  service.confirmScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });

  const timeline = service.timeline("match-1", "audience", "Asia/Shanghai");
  const a1 = timeline.find((row) => row.athleteId === "A1");
  assert.equal(a1.statusLabel, "正式");
  assert.equal(a1.appealDeadlineUtc, "2026-09-26T08:30:00.000Z");
  assert.ok(a1.appealDeadlineLocal.includes("16:30"));
  assert.equal(a1.zone, "Asia/Shanghai");

  const a2 = timeline.find((row) => row.athleteId === "A2");
  assert.equal(a2.statusLabel, "临时");
  assert.equal(a2.appealDeadlineUtc, null);
});
