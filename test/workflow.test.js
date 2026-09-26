import test from "node:test";
import assert from "node:assert/strict";
import { OFFICIAL, makeHarness, setupMatch } from "./helpers.js";

test("成绩状态流转：临时 → 待确认 → 正式", () => {
  const { service } = makeHarness();
  setupMatch(service);

  let view = service.scorecard("match-1", "A1", "audience");
  assert.equal(view.status, "provisional");
  assert.equal(view.statusLabel, "临时");

  service.reviewScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });
  view = service.scorecard("match-1", "A1", "audience");
  assert.equal(view.statusLabel, "待确认");

  service.confirmScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });
  view = service.scorecard("match-1", "A1", "audience");
  assert.equal(view.statusLabel, "正式");
});

test("并发复核只形成一个正式版本", () => {
  const { service } = makeHarness();
  setupMatch(service);
  service.reviewScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });

  // 第一名裁判确认成功
  const first = service.confirmScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });
  assert.equal(first.status, "official");

  // 并发复核的第二名裁判持同一版本号确认 → 冲突
  assert.throws(
    () =>
      service.confirmScorecard("match-1", "A1", {
        expectedVersion: 60,
        officialId: "ref-02",
        signature: "sig-ref-02",
      }),
    /只能形成一个正式版本/,
  );

  // 版本号过期的复核同样被拒绝
  assert.throws(
    () => service.reviewScorecard("match-1", "A2", { expectedVersion: 1, ...OFFICIAL }),
    /版本已变化/,
  );
});

test("待确认期间的修正使复核作废，须重新复核", () => {
  const { service } = makeHarness();
  setupMatch(service);
  service.reviewScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });

  service.correct("match-1", {
    type: "penalty",
    athleteId: "A1",
    rings: 1,
    reason: "迟到",
    ...OFFICIAL,
  });

  const view = service.scorecard("match-1", "A1", "referee");
  assert.equal(view.status, "provisional");
  assert.equal(view.version, 61);
  assert.throws(
    () => service.confirmScorecard("match-1", "A1", { expectedVersion: 61, ...OFFICIAL }),
    /只能形成一个正式版本/,
  );
});

test("正式成绩只能凭已成立的申诉修正，原正式记录保留", () => {
  const { service } = makeHarness();
  setupMatch(service);
  service.reviewScorecard("match-1", "A2", { expectedVersion: 60, ...OFFICIAL });
  service.confirmScorecard("match-1", "A2", { expectedVersion: 60, ...OFFICIAL });

  // 直接修正被拒绝
  assert.throws(
    () =>
      service.correct("match-1", {
        type: "penalty",
        athleteId: "A2",
        rings: 2,
        reason: "补充判罚",
        ...OFFICIAL,
      }),
    /已成立的申诉/,
  );

  // 申诉成立后可修正；原正式记录移入历史
  const { appealId } = service.fileAppeal("match-1", { athleteId: "A2", reason: "漏记判罚" });
  service.resolveAppeal("match-1", appealId, { outcome: "upheld", ...OFFICIAL });
  service.correct("match-1", {
    type: "penalty",
    athleteId: "A2",
    rings: 2,
    reason: "补充判罚",
    appealId,
    ...OFFICIAL,
  });

  const view = service.scorecard("match-1", "A2", "referee");
  assert.equal(view.status, "provisional"); // 修正后须重新复核确认
  assert.equal(view.total, 625.0);
  assert.equal(view.supersededOfficial.version, 60); // 原正式版本保留
  assert.equal(view.displayedOriginally.total, 627.0);
});

test("弃权运动员不再排名，且不能再记录发弹", () => {
  const { service } = makeHarness();
  setupMatch(service);
  service.correct("match-1", { type: "withdrawal", athleteId: "C1", reason: "伤病", ...OFFICIAL });

  const individual = service.rankings("match-1", "individual", "audience");
  const c1 = individual.find((row) => row.athleteId === "C1");
  assert.equal(c1.withdrawn, true);
  assert.equal(c1.rank, null);
  assert.equal(individual.filter((row) => row.rank !== null).length, 6);

  assert.throws(
    () =>
      service.recordShot("match-1", {
        athleteId: "C1",
        targetId: "T-C1",
        series: 6,
        shot: 10,
        value: 10.0,
        firedAtUtc: "2026-09-26T10:00:00.000Z",
        device: { id: "DEV-T-C1", clockOffsetMs: 0 },
      }),
    /已弃权/,
  );
});

test("团体与个人引用同一发弹数据，排名各自独立", () => {
  const { service } = makeHarness();
  setupMatch(service);

  const individual = service.rankings("match-1", "individual", "audience");
  const teams = service.rankings("match-1", "team", "audience");

  // 个人排名：A1 居首
  assert.equal(individual[0].athleteId, "A1");
  assert.equal(individual[0].total, 636.8);

  // 团体排名是独立序列，但数值来自同一批发弹
  const chn = teams.find((row) => row.teamId === "CHN");
  const kor = teams.find((row) => row.teamId === "KOR");
  assert.equal(chn.rank, 1);
  assert.equal(chn.total, 636.8 + 627.0 + 627.0);
  assert.equal(kor.total, 3 * 627.0);
  assert.equal(chn.complete, true);

  // 对一发的修正同时反映到两个排名
  service.correct("match-1", {
    type: "penalty",
    athleteId: "A2",
    rings: 2,
    reason: "装备检查不合格",
    ...OFFICIAL,
  });
  const chnAfter = service.rankings("match-1", "team", "audience").find((row) => row.teamId === "CHN");
  assert.equal(chnAfter.total, 636.8 + 625.0 + 627.0);
  const a2 = service.rankings("match-1", "individual", "audience").find((row) => row.athleteId === "A2");
  assert.equal(a2.total, 625.0);
});

test("申诉窗口：逾期申诉被拒绝", () => {
  const { service, advance } = makeHarness();
  setupMatch(service);
  service.reviewScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });
  service.confirmScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });

  advance(29);
  const ok = service.fileAppeal("match-1", { athleteId: "A1", reason: "对判罚有异议" });
  assert.ok(ok.appealDeadlineUtc);

  service.resolveAppeal("match-1", ok.appealId, { outcome: "dismissed", ...OFFICIAL });
  advance(2); // 正式确认后 31 分钟，超过 30 分钟窗口
  assert.throws(
    () => service.fileAppeal("match-1", { athleteId: "A1", reason: "逾期申诉" }),
    /超过申诉截止/,
  );
});

test("校准异常以追加事件记录，相关发弹标记可疑", () => {
  const { service } = makeHarness();
  setupMatch(service);
  service.correct("match-1", {
    type: "calibration_anomaly",
    targetId: "T-C1",
    detail: "校准漂移 0.3 环",
    ...OFFICIAL,
  });

  const view = service.scorecard("match-1", "C1", "technical_delegate");
  assert.equal(view.calibrationReports.length, 1);
  assert.equal(view.calibrationReports[0].targetId, "T-C1");
  assert.ok(view.shots.every((shot) => shot.suspect));
});
