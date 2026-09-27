import test from "node:test";
import assert from "node:assert/strict";
import { EventStore } from "../src/domain/store.js";
import { foldEvents, computeResults, rankIndividuals, rankTeams } from "../src/domain/aggregate.js";
import { createEvent, EVENT_TYPES, VOID_REASONS } from "../src/domain/events.js";
import { toTenths, formatRing } from "../src/domain/rules.js";

const T0 = "2024-05-01T01:00:00Z";

function E(type, payload, atUtc = T0) {
  return createEvent(type, payload, {
    atUtc: payload.atUtc ?? atUtc,
    actorId: "R1",
    actorRole: "REFEREE",
    source: "test",
  });
}

function baseEvents() {
  return [
    E(EVENT_TYPES.COMPETITION_OPENED, {
      competitionId: "C1",
      name: "测试赛",
      discipline: "AR60W",
      ruleVersion: "ISSF-RIFLE-2022",
      startedAtUtc: T0,
      timezone: "Asia/Shanghai",
    }),
    E(EVENT_TYPES.LANE_DEVICE_REGISTERED, { laneId: "L1", deviceId: "ET1" }),
    E(EVENT_TYPES.CALIBRATION_CHECK, { laneId: "L1", verdict: "PASS", driftTenths: 0 }),
  ];
}

function shot(athleteId, series, position, tenths, atUtc) {
  return E(
    EVENT_TYPES.SHOT_RECORDED,
    { athleteId, shotId: `${athleteId}-S${series}P${position}`, series, position, tenths, laneId: "L1" },
    atUtc,
  );
}

test("十分位环值：整数 tenths 与一位小数等价，显示保留一位", () => {
  assert.equal(toTenths("9.1"), 91);
  assert.equal(toTenths(10.5), 105);
  assert.equal(toTenths(109), 109);
  assert.equal(formatRing(91), "9.1");
  assert.throws(() => toTenths(110), /环值越界/);
});

test("补射修正：原弹保留但不计分，补射弹替换，总环按补射计算", () => {
  const events = [
    ...baseEvents(),
    E(EVENT_TYPES.ATHLETE_REGISTERED, { athleteId: "A1", displayName: "甲", bib: "1" }),
    E(EVENT_TYPES.ATHLETE_LANE_ASSIGNED, { athleteId: "A1", laneId: "L1" }),
    shot("A1", 6, 1, 91),
    E(EVENT_TYPES.SHOT_VOIDED, {
      athleteId: "A1",
      shotId: "A1-S6P1",
      reason: VOID_REASONS.CALIBRATION_DRIFT,
    }),
    E(EVENT_TYPES.RESHOT_AWARDED, {
      athleteId: "A1",
      voidedShotId: "A1-S6P1",
      replacementShotId: "A1-S6P1-R",
    }),
    E(
      EVENT_TYPES.SHOT_RECORDED,
      { athleteId: "A1", shotId: "A1-S6P1-R", series: 6, position: 1, tenths: 105, laneId: "L1" },
      "2024-05-01T01:30:00Z",
    ),
  ];
  const state = foldEvents(events);
  const result = computeResults(state).get("A1");
  assert.equal(result.totalTenths, 105);
  assert.equal(result.shotCount, 1);
  // 原始弹与作废记录都仍在
  assert.equal(state.athletes.get("A1").shots.get("A1-S6P1").tenths, 91);
  assert.ok(state.athletes.get("A1").voided.has("A1-S6P1"));
  assert.deepEqual(result.anomalies.map((a) => a.code), ["MISSING_SHOTS"]);
});

test("判罚扣分：影响总环并落到指定系列，原始小计不变", () => {
  const events = [
    ...baseEvents(),
    E(EVENT_TYPES.ATHLETE_REGISTERED, { athleteId: "A1", displayName: "甲", bib: "1" }),
    E(EVENT_TYPES.ATHLETE_LANE_ASSIGNED, { athleteId: "A1", laneId: "L1" }),
    shot("A1", 1, 1, 105),
    shot("A1", 1, 2, 105),
    E(EVENT_TYPES.PENALTY_DEDUCTED, {
      athleteId: "A1",
      deductionTenths: 2,
      reason: "超时发射",
      series: 1,
      rule: "7.6.4",
    }),
  ];
  const result = computeResults(foldEvents(events)).get("A1");
  assert.equal(result.subtotalTenths, 210);
  assert.equal(result.deductionTenths, 2);
  assert.equal(result.totalTenths, 208);
  assert.equal(result.seriesTotals[0], 208);
});

test("弃权：个人排名排除，团体仅累计未弃权成员", () => {
  const events = [
    ...baseEvents(),
    E(EVENT_TYPES.TEAM_REGISTERED, { teamId: "T1", displayName: "一队", memberIds: ["A1", "A2"] }),
    E(EVENT_TYPES.ATHLETE_REGISTERED, { athleteId: "A1", displayName: "甲", bib: "1" }),
    E(EVENT_TYPES.ATHLETE_REGISTERED, { athleteId: "A2", displayName: "乙", bib: "2" }),
    E(EVENT_TYPES.ATHLETE_LANE_ASSIGNED, { athleteId: "A1", laneId: "L1" }),
    E(EVENT_TYPES.ATHLETE_LANE_ASSIGNED, { athleteId: "A2", laneId: "L1" }),
    shot("A1", 1, 1, 109),
    shot("A2", 1, 1, 100),
    E(EVENT_TYPES.ATHLETE_WITHDRAWN, { athleteId: "A1", reason: "伤病" }, "2024-05-01T01:20:00Z"),
  ];
  const state = foldEvents(events);
  const results = computeResults(state);
  const ranked = rankIndividuals(results, state.athletes);
  assert.deepEqual(ranked.map((r) => r.athleteId), ["A2"]);
  const teams = rankTeams(results, state.teams, state.athletes);
  assert.equal(teams[0].totalTenths, 100); // A1 的 10.9 不计入团体
});

test("平局破除：总环相同先比内十环，再比末系列与末发", () => {
  // 在同一赛事内构造运动员，每人的弹着直接给出。
  function buildState(perAthlete) {
    const events = [
      baseEvents()[0],
      E(EVENT_TYPES.LANE_DEVICE_REGISTERED, { laneId: "L1", deviceId: "ET1" }),
      E(EVENT_TYPES.CALIBRATION_CHECK, { laneId: "L1", verdict: "PASS" }),
    ];
    for (const [id, shots] of Object.entries(perAthlete)) {
      events.push(
        E(EVENT_TYPES.ATHLETE_REGISTERED, { athleteId: id, displayName: id, bib: id }),
        E(EVENT_TYPES.ATHLETE_LANE_ASSIGNED, { athleteId: id, laneId: "L1" }),
      );
      for (const [s, p, v, t] of shots) {
        events.push(
          E(
            EVENT_TYPES.SHOT_RECORDED,
            { athleteId: id, shotId: `${id}-S${s}P${p}`, series: s, position: p, tenths: v, laneId: "L1" },
            t,
          ),
        );
      }
    }
    return foldEvents(events);
  }

  // 内十环优先：A=10.9+10.1（2 内十），B=10.9+9.9+0.2（1 内十），总环同为 21.0
  const s1 = buildState({
    A: [
      [6, 1, 109, "2024-05-01T01:00:00Z"],
      [6, 2, 101, "2024-05-01T01:01:00Z"],
    ],
    B: [
      [6, 1, 109, "2024-05-01T01:00:00Z"],
      [6, 2, 99, "2024-05-01T01:01:00Z"],
      [6, 3, 2, "2024-05-01T01:02:00Z"],
    ],
  });
  assert.equal(rankIndividuals(computeResults(s1), s1.athletes)[0].athleteId, "A");

  // 末发倒序：C=10.5+10.5，D=10.9+10.1；总环与内十环相同，C 末发更高
  const s2 = buildState({
    D: [
      [6, 1, 109, "2024-05-01T01:00:00Z"],
      [6, 2, 101, "2024-05-01T01:01:00Z"],
    ],
    C: [
      [6, 1, 105, "2024-05-01T01:00:00Z"],
      [6, 2, 105, "2024-05-01T01:01:00Z"],
    ],
  });
  assert.deepEqual(
    rankIndividuals(computeResults(s2), s2.athletes).map((x) => x.athleteId),
    ["C", "D"],
  );
});

test("团体与个人引用同一批弹着数据但独立排名", () => {
  const events = [
    ...baseEvents(),
    E(EVENT_TYPES.TEAM_REGISTERED, { teamId: "T1", displayName: "一队", memberIds: ["A1", "A2"] }),
    E(EVENT_TYPES.ATHLETE_REGISTERED, { athleteId: "A1", displayName: "甲", bib: "1" }),
    E(EVENT_TYPES.ATHLETE_REGISTERED, { athleteId: "A2", displayName: "乙", bib: "2" }),
    E(EVENT_TYPES.ATHLETE_LANE_ASSIGNED, { athleteId: "A1", laneId: "L1" }),
    E(EVENT_TYPES.ATHLETE_LANE_ASSIGNED, { athleteId: "A2", laneId: "L1" }),
    shot("A1", 6, 1, 109), // 个人更高
    shot("A2", 6, 1, 105),
  ];
  const state = foldEvents(events);
  const results = computeResults(state);
  assert.equal(rankIndividuals(results, state.athletes)[0].athleteId, "A1");
  const team = rankTeams(results, state.teams, state.athletes)[0];
  assert.equal(team.totalTenths, 214); // 同一批数据求和
  assert.deepEqual([...team.memberIds].sort(), ["A1", "A2"]);
});

test("现场显示冻结：修正后原始显示结果仍保留，不被覆盖", async () => {
  const store = new EventStore();
  await store.appendAll([
    ...baseEvents(),
    E(EVENT_TYPES.ATHLETE_REGISTERED, { athleteId: "A1", displayName: "甲", bib: "1" }),
    E(EVENT_TYPES.ATHLETE_LANE_ASSIGNED, { athleteId: "A1", laneId: "L1" }),
    shot("A1", 6, 1, 91),
    E(EVENT_TYPES.DISPLAY_SNAPSHOT_FROZEN, {
      athleteId: "A1",
      label: "大屏",
      totalTenths: 91,
    }),
    E(EVENT_TYPES.SHOT_VOIDED, { athleteId: "A1", shotId: "A1-S6P1", reason: VOID_REASONS.CALIBRATION_DRIFT }),
    E(EVENT_TYPES.RESHOT_AWARDED, {
      athleteId: "A1",
      voidedShotId: "A1-S6P1",
      replacementShotId: "A1-S6P1-R",
    }),
    E(
      EVENT_TYPES.SHOT_RECORDED,
      { athleteId: "A1", shotId: "A1-S6P1-R", series: 6, position: 1, tenths: 105, laneId: "L1" },
      "2024-05-01T01:30:00Z",
    ),
    E(
      EVENT_TYPES.DISPLAY_SNAPSHOT_FROZEN,
      { athleteId: "A1", label: "补射后大屏", totalTenths: 105 },
      "2024-05-01T01:31:00Z",
    ),
  ]);
  const state = store.replay();
  const snapshots = state.athletes.get("A1").displaySnapshots;
  assert.deepEqual(snapshots.map((d) => d.totalTenths), [91, 105]);
  assert.equal(computeResults(state).get("A1").totalTenths, 105);
});

test("校准异常期内的弹着被标记 CALIBRATION_SUSPECT", () => {
  const events = [
    baseEvents()[0],
    E(EVENT_TYPES.LANE_DEVICE_REGISTERED, { laneId: "L1", deviceId: "ET1" }),
    E(EVENT_TYPES.CALIBRATION_CHECK, { laneId: "L1", verdict: "PASS" }, "2024-05-01T00:59:00Z"),
    E(EVENT_TYPES.ATHLETE_REGISTERED, { athleteId: "A1", displayName: "甲", bib: "1" }),
    E(EVENT_TYPES.ATHLETE_LANE_ASSIGNED, { athleteId: "A1", laneId: "L1" }),
    shot("A1", 1, 1, 105, "2024-05-01T01:00:00Z"),
    E(EVENT_TYPES.CALIBRATION_CHECK, { laneId: "L1", verdict: "FAIL", driftTenths: 12 }, "2024-05-01T01:05:00Z"),
    shot("A1", 1, 2, 105, "2024-05-01T01:10:00Z"), // 异常期
  ];
  const result = computeResults(foldEvents(events)).get("A1");
  assert.ok(result.anomalies.some((a) => a.code === "CALIBRATION_SUSPECT"));
  assert.ok(result.anomalies.some((a) => a.code === "CALIBRATION_UNRESOLVED"));
});
