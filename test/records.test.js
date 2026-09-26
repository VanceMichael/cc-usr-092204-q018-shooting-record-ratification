import test from "node:test";
import assert from "node:assert/strict";
import { OFFICIAL, makeHarness, setupMatch } from "./helpers.js";

const TD = "technical_delegate";

function confirmA1(service) {
  service.reviewScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });
  return service.confirmScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });
}

test("正式总环值超现行纪录才登记候选，媒体快讯无认定效力", () => {
  const { service } = makeHarness();
  setupMatch(service);

  // 未正式确认前没有任何纪录候选
  assert.equal(service.records(TD).length, 0);

  const { candidates } = confirmA1(service);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].level, "ASIAN");
  assert.equal(candidates[0].total, 636.8);
  assert.equal(candidates[0].status, "pending");

  // 观众在认定前看不到待定候选
  assert.equal(service.records("audience").length, 0);
});

test("六项确认齐全才转正，申诉窗口须确实关闭", () => {
  const { service, advance } = makeHarness();
  setupMatch(service);
  const { candidates } = confirmA1(service);
  const candidateId = candidates[0].id;

  // 窗口未关闭时不能确认该项
  assert.throws(
    () =>
      service.approveRecordStep(
        candidateId,
        { step: "appeal_window", officialId: "td-01", signature: "sig-td" },
        TD,
      ),
    /尚未关闭/,
  );

  for (const step of ["identity", "target_equipment", "shot_data", "time_sync", "equipment_control"]) {
    service.approveRecordStep(candidateId, { step, officialId: "td-01", signature: "sig-td" }, TD);
  }
  assert.equal(service.records(TD).find((c) => c.id === candidateId).status, "pending");

  advance(31); // 超过 30 分钟申诉窗口
  const ratified = service.approveRecordStep(
    candidateId,
    { step: "appeal_window", officialId: "td-01", signature: "sig-td" },
    TD,
  );
  assert.equal(ratified.status, "ratified");

  // 观众现在能看到正式纪录
  const publicRecords = service.records("audience");
  assert.equal(publicRecords.length, 1);
  assert.equal(publicRecords[0].total, 636.8);
  assert.equal(publicRecords[0].approvals, undefined); // 签名细节不对观众开放
});

test("存在未结申诉时申诉窗口不能确认关闭", () => {
  const { service, advance } = makeHarness();
  setupMatch(service);
  const { candidates } = confirmA1(service);
  const candidateId = candidates[0].id;

  service.fileAppeal("match-1", { athleteId: "A1", reason: "对计时有异议" });
  advance(31);
  assert.throws(
    () =>
      service.approveRecordStep(
        candidateId,
        { step: "appeal_window", officialId: "td-01", signature: "sig-td" },
        TD,
      ),
    /未结申诉/,
  );
});

test("非技术代表不能确认认定环节", () => {
  const { service } = makeHarness();
  setupMatch(service);
  const { candidates } = confirmA1(service);
  assert.throws(
    () =>
      service.approveRecordStep(
        candidates[0].id,
        { step: "identity", officialId: "x", signature: "y" },
        "referee",
      ),
    /技术代表/,
  );
});

test("技术代表可从纪录重放全部计算、校准与批准证据", () => {
  const { service, advance } = makeHarness();
  setupMatch(service);

  // 制造证据链：校准异常 + 补射 + 判罚都发生在 A1 之前先给别人，
  // A1 自身的证据是一次补射
  service.correct("match-1", {
    type: "reshoot",
    athleteId: "A1",
    series: 2,
    shot: 3,
    reason: "靶纸异常",
    ...OFFICIAL,
  });
  service.recordShot("match-1", {
    athleteId: "A1",
    targetId: "T-A1",
    series: 2,
    shot: 3,
    value: 10.6,
    firedAtUtc: "2026-09-26T09:50:00.000Z",
    device: { id: "DEV-T-A1", clockOffsetMs: 3 },
  });
  service.correct("match-1", {
    type: "calibration_anomaly",
    targetId: "T-B1",
    detail: "校准偏差",
    ...OFFICIAL,
  });

  service.reviewScorecard("match-1", "A1", { expectedVersion: 62, ...OFFICIAL });
  const { candidates } = service.confirmScorecard("match-1", "A1", { expectedVersion: 62, ...OFFICIAL });
  const candidateId = candidates[0].id;

  // 观众与裁判都不能重放
  assert.throws(() => service.replayRecord(candidateId, "audience"), /技术代表/);
  assert.throws(() => service.replayRecord(candidateId, "referee"), /技术代表/);

  const replay = service.replayRecord(candidateId, TD);
  assert.equal(replay.rulesetId, "issf-ar60-2024");
  assert.equal(replay.shots.length, 61); // 60 发 + 1 发补射，作废的也保留
  assert.ok(replay.shots.some((shot) => shot.voided));
  assert.ok(replay.shots.some((shot) => shot.reshoot));
  assert.equal(replay.calibrationReports.length, 1);
  assert.equal(replay.scorecardVersions.length, 62);
  assert.equal(replay.recomputation.consistent, true);
  assert.equal(replay.recomputation.total, 636.8);

  // 批准证据随认定链累积，重放可见
  for (const step of ["identity", "target_equipment", "shot_data", "time_sync", "equipment_control"]) {
    service.approveRecordStep(candidateId, { step, officialId: "td-01", signature: "sig-td" }, TD);
  }
  advance(31);
  service.approveRecordStep(candidateId, { step: "appeal_window", officialId: "td-01", signature: "sig-td" }, TD);
  const after = service.replayRecord(candidateId, TD);
  assert.equal(Object.keys(after.approvals).length, 6);
  assert.equal(after.candidate.status, "ratified");
});

test("新正式成绩超过待定候选时另立候选，转正后淘汰更低者", () => {
  const { service, advance } = makeHarness();
  setupMatch(service);

  // A2 先正式确认 627.0 → 候选
  service.reviewScorecard("match-1", "A2", { expectedVersion: 60, ...OFFICIAL });
  const first = service.confirmScorecard("match-1", "A2", { expectedVersion: 60, ...OFFICIAL });
  assert.equal(first.candidates[0].total, 627.0);

  // A1 随后 636.8 → 另立更高候选
  const second = confirmA1(service);
  assert.equal(second.candidates[0].total, 636.8);

  // 更高候选转正后，更低候选被淘汰
  const id = second.candidates[0].id;
  for (const step of ["identity", "target_equipment", "shot_data", "time_sync", "equipment_control"]) {
    service.approveRecordStep(id, { step, officialId: "td-01", signature: "sig-td" }, TD);
  }
  advance(31);
  service.approveRecordStep(id, { step: "appeal_window", officialId: "td-01", signature: "sig-td" }, TD);

  const all = service.records(TD);
  assert.equal(all.find((c) => c.id === first.candidates[0].id).status, "superseded");
  assert.equal(all.find((c) => c.id === id).status, "ratified");
});
