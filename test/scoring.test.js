import test from "node:test";
import assert from "node:assert/strict";
import { computeAthleteScore, projectMatch } from "../src/domain/projection.js";
import { getRuleset, round1 } from "../src/domain/rulesets.js";
import {
  OFFICIAL,
  card636_8,
  enterAthlete,
  makeHarness,
  recordCard,
  registerMatch,
} from "./helpers.js";

test("按竞赛版本计算分项与总环值", () => {
  const { service } = makeHarness();
  registerMatch(service);
  enterAthlete(service, "A1", "CHN");
  recordCard(service, "A1", card636_8());

  const scorecard = service.scorecard("match-1", "A1", "referee");
  assert.equal(scorecard.series.length, 6);
  assert.equal(scorecard.series[0].total, 106.8); // 8×10.7 + 2×10.6
  assert.equal(scorecard.total, 636.8);
  assert.equal(scorecard.penaltyRings, 0);
});

test("一位小数求和消除浮点误差", () => {
  assert.equal(round1(10.6 * 52 + 10.7 * 8), 636.8);
  assert.equal(round1(0.1 + 0.2), 0.3);
});

test("不同竞赛版本参数不同，比赛固定其一", () => {
  assert.equal(getRuleset("issf-ar60-2022").appealWindowMinutes, 20);
  assert.equal(getRuleset("issf-ar60-2024").appealWindowMinutes, 30);
  const { service } = makeHarness();
  const { ruleset } = registerMatch(service, { rulesetId: "issf-ar60-2022" });
  assert.equal(ruleset.appealWindowMinutes, 20);
});

test("环值越界与刻度非法被拒绝", () => {
  const { service } = makeHarness();
  registerMatch(service);
  enterAthlete(service, "A1");
  const shot = {
    athleteId: "A1",
    targetId: "T1",
    series: 1,
    shot: 1,
    firedAtUtc: "2026-09-26T09:30:00.000Z",
    device: { id: "DEV-1", clockOffsetMs: 0 },
  };
  assert.throws(() => service.recordShot("match-1", { ...shot, value: 11 }), /超出范围/);
  assert.throws(() => service.recordShot("match-1", { ...shot, value: 10.55 }), /0\.1/);
});

test("判罚以追加事件扣减总环，原始显示保留", () => {
  const { service } = makeHarness();
  registerMatch(service);
  enterAthlete(service, "A1");
  recordCard(service, "A1", card636_8());

  service.correct("match-1", {
    type: "penalty",
    athleteId: "A1",
    rings: 2,
    reason: "装备检查不合格",
    ruleRef: "6.7.9",
    ...OFFICIAL,
  });

  const view = service.scorecard("match-1", "A1", "audience");
  assert.equal(view.total, 634.8);
  assert.equal(view.penaltyRings, 2);
  assert.equal(view.displayedOriginally.total, 636.8); // 原始显示结果不被覆盖
  assert.equal(view.version, 61); // 60 发 + 1 次判罚
});

test("作废与补射：旧发保留为作废，补射占据同一坐标", () => {
  const { service } = makeHarness();
  registerMatch(service);
  enterAthlete(service, "A1");
  recordCard(service, "A1", card636_8());

  service.correct("match-1", {
    type: "reshoot",
    athleteId: "A1",
    series: 3,
    shot: 5,
    reason: "靶位故障",
    ...OFFICIAL,
  });
  // 未获准补射前同坐标不能重复记录（已作废但未授权的另一坐标）
  service.correct("match-1", {
    type: "shot_void",
    athleteId: "A1",
    series: 4,
    shot: 6,
    reason: "裁判判定无效",
    ...OFFICIAL,
  });
  assert.throws(
    () =>
      service.recordShot("match-1", {
        athleteId: "A1",
        targetId: "T-A1",
        series: 4,
        shot: 6,
        value: 10.5,
        firedAtUtc: "2026-09-26T09:40:00.000Z",
        device: { id: "DEV-T-A1", clockOffsetMs: 3 },
      }),
    /须先获准补射/,
  );

  service.recordShot("match-1", {
    athleteId: "A1",
    targetId: "T-A1",
    series: 3,
    shot: 5,
    value: 10.9,
    firedAtUtc: "2026-09-26T09:41:00.000Z",
    device: { id: "DEV-T-A1", clockOffsetMs: 3 },
  });

  const state = projectMatch(service.store.ofMatch("match-1"));
  const computed = computeAthleteScore(state, "A1");
  // 原 3-5（10.6）作废 → 补射 10.9；4-6（10.6）作废无补射
  assert.equal(computed.total, round1(636.8 - 10.6 + 10.9 - 10.6));
  const refereeView = service.scorecard("match-1", "A1", "referee");
  const voided = refereeView.shots.filter((shot) => shot.voided);
  assert.equal(voided.length, 2);
  assert.ok(refereeView.shots.some((shot) => shot.reshoot));
});

test("重复坐标与未知比赛被拒绝", () => {
  const { service } = makeHarness();
  registerMatch(service);
  enterAthlete(service, "A1");
  const shot = {
    athleteId: "A1",
    targetId: "T1",
    series: 1,
    shot: 1,
    value: 10.1,
    firedAtUtc: "2026-09-26T09:30:00.000Z",
    device: { id: "DEV-1", clockOffsetMs: 0 },
  };
  service.recordShot("match-1", shot);
  assert.throws(() => service.recordShot("match-1", shot), /已有有效发弹/);
  assert.throws(() => service.recordShot("no-such-match", shot), /比赛不存在/);
});
