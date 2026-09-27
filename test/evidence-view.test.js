import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidencePackage } from "../src/app/evidence.js";
import { projectAthleteView, buildScoreboard, STATUS } from "../src/app/view.js";
import { ROLES } from "../src/app/roles.js";
import { bootstrapService } from "../src/app/bootstrap.js";
import { EventStore } from "../src/domain/store.js";
import { zonedDateTime, offsetMinutesAt, formatInstant } from "../src/domain/clock.js";

let service;

test.before(async () => {
  service = await bootstrapService();
});

test("时区：UTC 内部时刻按 Asia/Shanghai 展示，截止时刻为本地 10:10:30（+08:00）", () => {
  assert.equal(offsetMinutesAt("2023-09-24T01:00:00Z", "Asia/Shanghai"), 480);
  assert.equal(zonedDateTime("2023-09-24T01:00:30Z", "Asia/Shanghai"), "2023-09-24T09:00:30");
  const state = service.getState();
  const v = state.versions.get("V-Q-001");
  assert.equal(formatInstant(v.protestDeadlineUtc, "Asia/Shanghai"), "2023-09-24T10:10:30+08:00");
  // 同一时刻在 UTC 视角仍是 02:10:30Z
  assert.equal(v.protestDeadlineUtc, "2023-09-24T02:10:30.000Z");
});

test("记分板三态：场景结束时为正式，纪录与 636.8 在榜，媒体快讯带提示", () => {
  const board = buildScoreboard(service.getState(), { nowUtc: "2023-09-24T02:20:00Z" });
  assert.equal(board.board.status, STATUS.OFFICIAL);
  assert.equal(board.board.statusLabel, "正式");
  const top = board.board.individuals[0];
  assert.equal(top.athleteId, "A-CHN-101");
  assert.equal(top.total, "636.8");
  assert.ok(top.record);
  assert.equal(top.record.type, "ASIAN_RECORD_AR60W_QUALIFICATION");
  const flash = board.flashes.find((f) => f.claimed === "636.8");
  assert.equal(flash.matchesOfficial, true);
  assert.match(flash.advisory, /不构成正式认定/);
});

test("原始显示保留：证据包内含 635.4 与 636.8 两次大屏，逐发重算一致", () => {
  const pkg = buildEvidencePackage(service.store, {
    versionId: "V-Q-001",
    athleteId: "A-CHN-101",
    nowUtc: "2023-09-24T02:20:00Z",
  });
  assert.equal(pkg.chain.intact, true);
  const c = pkg.computations[0];
  assert.equal(c.consistent, true);
  assert.equal(c.totals.total, "636.8");
  assert.deepEqual(c.frozenDisplays.map((d) => d.shown), ["635.4", "636.8"]);
  // 第 3 系列计入的是补射弹 10.5，原 9.1 留在修正记录里
  const s3 = c.series.find((s) => s.series === 3);
  const p7 = s3.shots.find((s) => s.position === 7);
  assert.equal(p7.shotId, "A-CHN-101-S3P7-R");
  assert.equal(p7.ring, "10.5");
  const voided = c.corrections.voidedShots.find((x) => x.shotId === "A-CHN-101-S3P7");
  assert.ok(voided);
  assert.equal(voided.reason, "CALIBRATION_DRIFT");
  // 六道门禁证据与认证/认定批准齐全
  assert.equal(pkg.gateEvidence.length, 6);
  assert.ok(pkg.gateEvidence.every((g) => g.evaluation.status === "PASS"));
  assert.equal(pkg.certification.by, "TD-001");
  assert.equal(pkg.record.certificateId, "AR-2023-0042");
});

test("证据链防篡改：改写任一历史事件后 verifyChain 在该 seq 报失配", () => {
  const copy = service.store.records().map((r) => structuredClone(r));
  const target = copy.find(
    (r) => r.event.type === "SHOT_RECORDED" && r.event.shotId === "A-CHN-101-S1P2",
  );
  target.event.tenths = 109; // 10.6 -> 10.9
  const tampered = new EventStore();
  tampered.loadPersisted(copy);
  const result = tampered.verifyChain();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, target.seq);
});

test("RBAC：观众看不到弹级/器材细节；本人可见本人但器材细节脱敏；官方可见设备与校准", () => {
  const state = service.getState();
  const spectator = projectAthleteView(state, "A-CHN-101", { role: ROLES.SPECTATOR });
  assert.equal(spectator.shots, undefined);
  assert.match(spectator.detailVisibility, /官方/);

  const self = projectAthleteView(state, "A-CHN-101", {
    role: ROLES.ATHLETE,
    athleteId: "A-CHN-101",
  });
  // 原始 60 发（含作废的 S3P7）+ 1 发补射
  assert.equal(self.shots.length, 61);
  assert.equal(self.laneId, "L01");
  assert.match(self.equipmentCheck.findings, /仅官方/);
  assert.equal(self.device, undefined); // 设备明细不向运动员开放

  const referee = projectAthleteView(state, "A-CHN-101", { role: ROLES.REFEREE, id: "R-001" });
  assert.equal(referee.device.serial, "SN-101-88");
  assert.equal(typeof referee.shots[0].deviceId, "string");
  const bad = referee.shots.find((s) => s.shotId === "A-CHN-101-S3P7");
  assert.equal(bad.voided.reason, "CALIBRATION_DRIFT");
});

test("团体与个人独立排名：同一发弹数据，个人第一为 101，团体为队总和", () => {
  const board = buildScoreboard(service.getState(), { nowUtc: "2023-09-24T02:20:00Z" });
  assert.equal(board.board.individuals[0].name, "选手101");
  // 636.8 + 629.4 + 627.1 = 1893.3
  const chn = board.board.teams.find((t) => t.name === "中国队");
  assert.equal(chn.total, "1893.3");
  assert.equal(board.board.teams[0].rank, 1);
});
