import test from "node:test";
import assert from "node:assert/strict";
import { CompetitionService } from "../src/app/service.js";
import { DomainError, ROLES } from "../src/app/roles.js";
import { buildReadyCompetition, REFEREE, JURY, TD } from "./helpers.js";

test("门禁未全部通过时技术代表不能认证正式版本", async () => {
  // 缺器材检查（EQUIPMENT 门禁数据不通过），也无任何门禁签名
  const service = await buildCompetitionWithoutEquipmentGate();
  await assert.rejects(
    () => service.certifyVersion({ versionId: "V1", atUtc: "2024-05-01T02:12:00Z" }, TD),
    (e) => e instanceof DomainError && e.code === "GATES_NOT_PASSED" && e.status === 409,
  );
});

async function buildCompetitionWithoutEquipmentGate() {
  const service = new CompetitionService();
  const t0 = "2024-05-01T01:00:00Z";
  await service.openCompetition(
    { competitionId: "CMP-X", name: "测试赛", discipline: "AR60W", ruleVersion: "ISSF-RIFLE-2022", startedAtUtc: t0, timezone: "Asia/Shanghai", atUtc: t0 },
    REFEREE,
  );
  await service.registerAthlete({ athleteId: "A1", displayName: "甲", bib: "1", atUtc: t0 }, REFEREE);
  await service.registerLaneDevice({ laneId: "L1", deviceId: "ET1", atUtc: t0 }, REFEREE);
  await service.assignLane({ athleteId: "A1", laneId: "L1", atUtc: t0 }, REFEREE);
  await service.calibrationCheck({ laneId: "L1", verdict: "PASS", atUtc: t0 }, REFEREE);
  await service.timeSyncCheck({ verdict: "PASS", driftMillis: 5, atUtc: t0 }, REFEREE);
  // 故意不做器材检查
  for (let s = 1; s <= 6; s += 1) {
    for (let p = 1; p <= 10; p += 1) {
      await service.recordShot(
        { athleteId: "A1", shotId: `A1-S${s}P${p}`, series: s, position: p, tenths: 105, laneId: "L1", atUtc: t0 },
        REFEREE,
      );
    }
  }
  const ids = Array.from({ length: 60 }, (_, i) => `A1-S${Math.floor(i / 10) + 1}P${(i % 10) + 1}`);
  await service.signShots({ athleteId: "A1", shotIds: ids, atUtc: "2024-05-01T02:00:00Z" }, REFEREE);
  await service.publishVersion({ versionId: "V1", label: "初版", atUtc: "2024-05-01T02:00:30Z" }, REFEREE);
  return service;
}

test("六道门禁齐全且窗口关闭后，技术代表认证成功，随后媒体快讯不改变任何状态", async () => {
  const { service, deadline } = await buildReadyCompetition();
  const certAt = new Date(Date.parse(deadline) + 60000).toISOString();
  await service.certifyVersion({ versionId: "V1", atUtc: certAt }, TD);
  const state = service.getState();
  assert.deepEqual([...state.certifiedVersions], ["V1"]);

  // 媒体快讯即便环值相同，也只是快讯记录
  await service.publishFlash(
    { athleteId: "A1", headline: "快讯：630.0环", claimedTotalTenths: 6300, outlet: "X", atUtc: certAt },
    { id: "M1", role: ROLES.MEDIA },
  );
  assert.equal(service.getState().certifiedVersions.size, 1);
});

test("并发复核只产生一个正式版本：第二个认证收到 CONFLICT", async () => {
  const { service, deadline } = await buildReadyCompetition();
  const certAt = new Date(Date.parse(deadline) + 60000).toISOString();
  const [first, second] = await Promise.allSettled([
    service.certifyVersion({ versionId: "V1", atUtc: certAt }, TD),
    service.certifyVersion({ versionId: "V1", atUtc: certAt }, TD),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.code, "ALREADY_OFFICIAL");
  assert.equal(service.getState().certifiedVersions.size, 1);
});

test("已有正式版本后不能再发布新版本（正式链锁定）", async () => {
  const { service, deadline } = await buildReadyCompetition();
  await service.certifyVersion({ versionId: "V1", atUtc: new Date(Date.parse(deadline) + 60000).toISOString() }, TD);
  await assert.rejects(
    () => service.publishVersion({ versionId: "V2", label: "二版", atUtc: "2024-05-01T03:00:00Z" }, REFEREE),
    (e) => e.code === "OFFICIAL_LOCKED",
  );
});

test("纪录认定：环值与正式计算不符或未超越原纪录均被拒绝", async () => {
  const { service, deadline } = await buildReadyCompetition();
  // 60 发 ×10.5 = 630.0
  const certAt = new Date(Date.parse(deadline) + 60000).toISOString();
  await service.certifyVersion({ versionId: "V1", atUtc: certAt }, TD);

  await assert.rejects(
    () =>
      service.ratifyRecord(
        { versionId: "V1", athleteId: "A1", recordType: "ASIAN", claimedTotalTenths: 6301, certificateId: "C1", atUtc: certAt },
        TD,
      ),
    (e) => e.code === "TOTAL_MISMATCH",
  );
  await assert.rejects(
    () =>
      service.ratifyRecord(
        { versionId: "V1", athleteId: "A1", recordType: "ASIAN", claimedTotalTenths: 6300, previousRecordTenths: 6353, atUtc: certAt },
        TD,
      ),
    (e) => e.code === "NOT_A_RECORD",
  );
  await service.ratifyRecord(
    { versionId: "V1", athleteId: "A1", recordType: "ASIAN", claimedTotalTenths: 6300, previousRecordTenths: 6299, certificateId: "C1", atUtc: certAt },
    TD,
  );
  const r = service.getState().ratifications;
  assert.equal(r.length, 1);
  assert.equal(r[0].certificateId, "C1");
});

test("角色权限：观众不能上送弹着，裁判不能签署申诉窗口门禁，技术代表才能认证", async () => {
  const { service } = await buildReadyCompetition();
  await assert.rejects(
    () => service.recordShot({ athleteId: "A1", shotId: "x", series: 1, position: 1, tenths: 100 }, { id: "S", role: ROLES.SPECTATOR }),
    (e) => e.code === "FORBIDDEN" && e.status === 403,
  );
  await assert.rejects(
    () => service.submitGateEvidence({ versionId: "V1", gate: "PROTEST_WINDOW", verdict: "PASS" }, REFEREE),
    (e) => e.code === "FORBIDDEN",
  );
  await assert.rejects(
    () => service.certifyVersion({ versionId: "V1" }, REFEREE),
    (e) => e.code === "FORBIDDEN",
  );
});

test("申诉窗口：窗口内可提出，逾期拒绝；仲裁裁决后无未决申诉", async () => {
  const { service, publishedAt, deadline } = await buildReadyCompetition();
  // publishedAt+150s 在窗口内
  const id = await service.fileProtest(
    { athleteId: "A2", againstVersionId: "V1", reason: "异议", atUtc: new Date(Date.parse(publishedAt) + 150000).toISOString() },
    { id: "A2", role: ROLES.JURY },
  );
  assert.ok(id);
  await assert.rejects(
    () =>
      service.fileProtest(
        { athleteId: "A3", againstVersionId: "V1", reason: "逾期", atUtc: new Date(Date.parse(deadline) + 1000).toISOString() },
        { id: "A3", role: ROLES.JURY },
      ),
    (e) => e.code === "PROTEST_WINDOW_CLOSED" && e.status === 409,
  );
  await service.resolveProtest({ protestId: id, verdict: "REJECTED", atUtc: new Date(Date.parse(deadline) - 1000).toISOString() }, JURY);
  assert.equal([...service.getState().protests.values()][0].status, "RESOLVED");
});

test("运动员只能为本人提出申诉", async () => {
  const { service, publishedAt } = await buildReadyCompetition();
  await assert.rejects(
    () =>
      service.fileProtest(
        { athleteId: "A2", reason: "代申诉", atUtc: new Date(Date.parse(publishedAt) + 10000).toISOString() },
        { id: "A1p", role: ROLES.ATHLETE, athleteId: "A1" },
      ),
    (e) => e.code === "FORBIDDEN",
  );
});

test("弃权运动员被个人排名排除，但原始弹数据保留", async () => {
  const { service } = await buildReadyCompetition();
  await service.withdrawAthlete({ athleteId: "A1", reason: "伤病", atUtc: "2024-05-01T02:05:00Z" }, REFEREE);
  const state = service.getState();
  assert.equal(state.athletes.get("A1").shots.size, 60);
  assert.equal(state.athletes.get("A1").withdrawn, true);
});
