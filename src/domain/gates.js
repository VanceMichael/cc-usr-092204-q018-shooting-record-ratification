import { toMillis } from "./clock.js";

// 成绩确认六道门禁。媒体快讯不在其中——它不产生任何确认效力。
// 每道门禁都要求"客观数据核对"与"责任人签名证据"同时成立。
export const GATES = Object.freeze({
  IDENTITY: "IDENTITY", // 运动员身份（注册、号码布、靶位对应）
  DEVICE: "DEVICE", // 靶位设备：校准历史无未恢复异常
  SHOT_DATA: "SHOT_DATA", // 每发数据：完整、裁判逐发签名、无计算异常
  TIME_SYNC: "TIME_SYNC", // 时间同步：各靶时钟偏差在阈值内
  EQUIPMENT: "EQUIPMENT", // 器材检查
  PROTEST_WINDOW: "PROTEST_WINDOW", // 申诉窗口已关闭且无未决申诉
});

export const GATE_ORDER = [
  GATES.IDENTITY,
  GATES.DEVICE,
  GATES.SHOT_DATA,
  GATES.TIME_SYNC,
  GATES.EQUIPMENT,
  GATES.PROTEST_WINDOW,
];

export const GATE_TITLES = Object.freeze({
  IDENTITY: "运动员身份核验",
  DEVICE: "靶位设备校准",
  SHOT_DATA: "每发数据与裁判签名",
  TIME_SYNC: "时间同步",
  EQUIPMENT: "器材检查",
  PROTEST_WINDOW: "申诉窗口",
});

const TIME_SYNC_LIMIT_MILLIS = 1000;

// 取针对某版本提交的某门禁最新证据。
function gateEvidenceFor(state, versionId, gate) {
  return (state.gateEvidence ?? [])
    .filter((e) => e.versionId === versionId && e.gate === gate)
    .at(-1) ?? null;
}

function rankedAthleteIds(state, results) {
  return [...results.values()].filter((r) => !r.withdrawn).map((r) => r.athleteId);
}

// 逐门禁评估。status: PASS / WAIT（客观数据尚不完备）/ FAIL（数据不通过）/
// BLOCKED（等前置窗口）。evidence 字段记录责任人签名证据状态。
export function evaluateGates(state, version, options = {}) {
  const nowUtc = options.nowUtc ?? new Date().toISOString();
  const results = version.results;
  const ids = rankedAthleteIds(state, results);
  const out = [];

  // 1. 身份：每名计分运动员已注册且佩戴号码布，靶位指派明确。
  {
    const missing = ids.filter((id) => {
      const a = state.athletes.get(id);
      return !a || !a.bib || !a.laneId;
    });
    const evidence = gateEvidenceFor(state, version.versionId, GATES.IDENTITY);
    out.push(mkGate(GATES.IDENTITY, missing.length === 0, evidence, {
      checkedAthletes: ids.length,
      missing,
    }));
  }

  // 2. 设备：计分弹涉及的靶位最后一次校准结论为 PASS，且无未消除异常。
  {
    const badLanes = [];
    for (const id of ids) {
      for (const anomaly of results.get(id).anomalies) {
        if (anomaly.code === "CALIBRATION_SUSPECT" || anomaly.code === "CALIBRATION_UNRESOLVED") {
          badLanes.push(anomaly.laneId ?? state.athletes.get(id).laneId);
        }
      }
    }
    const uniqBadLanes = [...new Set(badLanes)].filter(Boolean);
    const evidence = gateEvidenceFor(state, version.versionId, GATES.DEVICE);
    out.push(mkGate(GATES.DEVICE, uniqBadLanes.length === 0, evidence, {
      suspectLanes: uniqBadLanes,
    }));
  }

  // 3. 每发数据：无计算异常、弹数完整、逐发裁判签名齐备。
  {
    const unsigned = [];
    const anomalyList = [];
    for (const id of ids) {
      const result = results.get(id);
      for (const anomaly of result.anomalies) anomalyList.push({ athleteId: id, ...anomaly });
      const athlete = state.athletes.get(id);
      for (const shot of result.seriesShots.flat()) {
        if (!athlete.signatures.has(shot.shotId)) unsigned.push(shot.shotId);
      }
    }
    const evidence = gateEvidenceFor(state, version.versionId, GATES.SHOT_DATA);
    const dataClean = unsigned.length === 0 && anomalyList.length === 0;
    out.push(mkGate(GATES.SHOT_DATA, dataClean, evidence, {
      unsignedShots: unsigned,
      anomalies: anomalyList,
    }));
  }

  // 4. 时间同步：最近一次 TIME_SYNC 为 PASS 且偏差不超过阈值。
  {
    const latest = [];
    for (const device of state.devices.values()) {
      const sync = [...device.checks].reverse().find((c) => c.kind === "TIME_SYNC");
      if (sync) latest.push({ laneId: device.laneId, ...sync });
    }
    const bad = latest.filter((c) => c.verdict !== "PASS" || Math.abs(c.driftMillis) > TIME_SYNC_LIMIT_MILLIS);
    const noCheck = state.devices.size > 0 && latest.length < state.devices.size;
    const evidence = gateEvidenceFor(state, version.versionId, GATES.TIME_SYNC);
    out.push(mkGate(GATES.TIME_SYNC, bad.length === 0 && !noCheck, evidence, {
      devices: latest.length,
      rejected: bad,
      noCheck,
    }));
  }

  // 5. 器材检查：每名计分运动员有 PASS 结论。
  {
    const missing = ids.filter((id) => state.athletes.get(id).equipmentCheck?.verdict !== "PASS");
    const evidence = gateEvidenceFor(state, version.versionId, GATES.EQUIPMENT);
    out.push(mkGate(GATES.EQUIPMENT, missing.length === 0, evidence, { missing }));
  }

  // 6. 申诉窗口：截止时刻已过，且无 OPEN 申诉。
  {
    const deadline = version.protestDeadlineUtc ?? options.protestDeadlineUtc ?? null;
    const open = [...state.protests.values()].filter((p) => p.status === "OPEN");
    const closed = deadline != null && toMillis(nowUtc) >= toMillis(deadline);
    const evidence = gateEvidenceFor(state, version.versionId, GATES.PROTEST_WINDOW);
    const g = mkGate(GATES.PROTEST_WINDOW, closed && open.length === 0, evidence, {
      deadlineUtc: deadline,
      nowUtc,
      openProtests: open.map((p) => p.protestId),
    });
    if (!closed) g.status = "WAIT";
    else if (open.length > 0) g.status = "FAIL";
    out.push(g);
  }

  return out;
}

function mkGate(gate, dataOk, evidence, detail) {
  const signed = evidence?.verdict === "PASS";
  let status;
  if (dataOk && signed) status = "PASS";
  else if (!dataOk) status = "FAIL";
  else status = "WAIT"; // 数据通过但责任人尚未签名
  return {
    gate,
    title: GATE_TITLES[gate],
    status,
    dataOk,
    signed,
    evidence: evidence
      ? { by: evidence.by, atUtc: evidence.atUtc, reference: evidence.reference, note: evidence.note }
      : null,
    detail,
  };
}

export function gatesAllPassed(gateResults) {
  return gateResults.every((g) => g.status === "PASS");
}

export function gatesSummary(gateResults) {
  return {
    passed: gateResults.filter((g) => g.status === "PASS").map((g) => g.gate),
    waiting: gateResults.filter((g) => g.status === "WAIT").map((g) => g.gate),
    failed: gateResults.filter((g) => g.status === "FAIL").map((g) => g.gate),
  };
}
