import { resolveRuleVersion, toTenths, toTotalTenths } from "./rules.js";
import { toMillis } from "./clock.js";
import { EVENT_TYPES } from "./events.js";

// 事件归约：把追加事件流折叠为赛事实体状态 + 按版本的成绩快照。
// 归约是纯函数，可对任意事件前缀重放——技术代表的证据重放即重跑本函数。

export function emptyState() {
  return {
    competition: null,
    athletes: new Map(),
    teams: new Map(),
    devices: new Map(), // laneId -> 设备与校准历史
    versions: new Map(), // versionId -> 发布快照
    versionOrder: [],
    certifiedVersions: new Set(),
    certifications: new Map(), // versionId -> { by, atUtc }
    ratifications: [],
    protests: new Map(),
    gateEvidence: [],
    flashes: [],
    sequence: 0,
  };
}

function ensureAthlete(state, athleteId) {
  let athlete = state.athletes.get(athleteId);
  if (!athlete) {
    athlete = {
      id: athleteId,
      displayName: null,
      bib: null,
      teamId: null,
      laneId: null,
      withdrawn: false,
      withdrawnReason: null,
      shots: new Map(), // shotId -> shot
      voided: new Map(), // shotId -> { reason, by, atUtc }
      reshots: [], // { voidedShotId, replacementShotId, atUtc }
      penalties: [], // { deductionTenths, reason, series, atUtc }
      signatures: new Map(), // shotId -> { refereeId, atUtc }
      displaySnapshots: [], // 现场大屏冻结：永不覆盖
    };
    state.athletes.set(athleteId, athlete);
  }
  return athlete;
}

export function foldEvent(state, event) {
  state.sequence += 1;
  switch (event.type) {
    case EVENT_TYPES.COMPETITION_OPENED: {
      if (state.competition) throw new Error("赛事已开启，不能重复开启");
      resolveRuleVersion(event.ruleVersion, event.startedAtUtc);
      state.competition = {
        id: event.competitionId,
        name: event.name,
        discipline: event.discipline,
        ruleVersion: event.ruleVersion,
        startedAtUtc: event.startedAtUtc,
        finishedAtUtc: event.finishedAtUtc ?? null,
        timezone: event.timezone,
        venue: event.venue ?? null,
        recordProtocol: event.recordProtocol ?? null,
        startConfirmed: false,
      };
      break;
    }

    case EVENT_TYPES.ATHLETE_REGISTERED: {
      const athlete = ensureAthlete(state, event.athleteId);
      athlete.displayName = event.displayName;
      athlete.bib = event.bib;
      if (event.teamId) athlete.teamId = event.teamId;
      break;
    }

    case EVENT_TYPES.TEAM_REGISTERED: {
      if (state.teams.has(event.teamId)) throw new Error(`团体重复注册: ${event.teamId}`);
      state.teams.set(event.teamId, {
        id: event.teamId,
        displayName: event.displayName,
        memberIds: [...event.memberIds],
      });
      for (const memberId of event.memberIds) ensureAthlete(state, memberId).teamId = event.teamId;
      break;
    }

    case EVENT_TYPES.LANE_DEVICE_REGISTERED: {
      state.devices.set(event.laneId, {
        laneId: event.laneId,
        deviceId: event.deviceId,
        model: event.model ?? null,
        serial: event.serial ?? null,
        checks: [],
      });
      break;
    }

    case EVENT_TYPES.ATHLETE_LANE_ASSIGNED: {
      ensureAthlete(state, event.athleteId).laneId = event.laneId;
      break;
    }

    case EVENT_TYPES.CALIBRATION_CHECK: {
      const device = state.devices.get(event.laneId);
      if (!device) throw new Error(`靶位未登记: ${event.laneId}`);
      device.checks.push({
        kind: "CALIBRATION",
        atUtc: event.atUtc,
        verdict: event.verdict,
        driftTenths: event.driftTenths ?? 0,
        note: event.note ?? null,
        inspectorId: event.actorId,
      });
      break;
    }

    case EVENT_TYPES.TIME_SYNC_CHECK: {
      for (const device of state.devices.values()) {
        device.checks.push({
          kind: "TIME_SYNC",
          atUtc: event.atUtc,
          verdict: event.verdict,
          driftMillis: event.driftMillis ?? 0,
          inspectorId: event.actorId,
        });
      }
      break;
    }

    case EVENT_TYPES.START_CONFIRMED: {
      state.competition.startConfirmed = true;
      break;
    }

    case EVENT_TYPES.EQUIPMENT_CHECK: {
      const athlete = ensureAthlete(state, event.athleteId);
      athlete.equipmentCheck = {
        atUtc: event.atUtc,
        verdict: event.verdict,
        findings: event.findings ?? null,
        inspectorId: event.actorId,
      };
      break;
    }

    case EVENT_TYPES.SHOT_RECORDED: {
      const athlete = ensureAthlete(state, event.athleteId);
      if (state.versions.has(event.shotId)) {
        // 不会发生：shotId 与 versionId 命名空间不同，这里只是防御
      }
      if (athlete.shots.has(event.shotId)) {
        throw new Error(`弹着重复上送: ${event.athleteId}/${event.shotId}`);
      }
      athlete.shots.set(event.shotId, {
        shotId: event.shotId,
        series: event.series,
        position: event.position,
        tenths: toTenths(event.tenths),
        rawTenths: event.rawTenths != null ? toTenths(event.rawTenths) : null,
        atUtc: event.atUtc,
        laneId: event.laneId ?? athlete.laneId,
        deviceId: event.deviceId ?? null,
        source: event.source ?? "electronic-target",
        seq: state.sequence,
      });
      break;
    }

    case EVENT_TYPES.SHOT_VOIDED: {
      const athlete = ensureAthlete(state, event.athleteId);
      if (!athlete.shots.has(event.shotId)) throw new Error(`作废了不存在的弹: ${event.shotId}`);
      if (athlete.voided.has(event.shotId)) throw new Error(`弹已作废: ${event.shotId}`);
      athlete.voided.set(event.shotId, {
        reason: event.reason,
        note: event.note ?? null,
        by: event.actorId,
        atUtc: event.atUtc,
      });
      break;
    }

    case EVENT_TYPES.RESHOT_AWARDED: {
      const athlete = ensureAthlete(state, event.athleteId);
      athlete.reshots.push({
        voidedShotId: event.voidedShotId,
        replacementShotId: event.replacementShotId,
        reason: event.reason ?? null,
        by: event.actorId,
        atUtc: event.atUtc,
      });
      break;
    }

    case EVENT_TYPES.PENALTY_DEDUCTED: {
      const athlete = ensureAthlete(state, event.athleteId);
      athlete.penalties.push({
        deductionTenths: toTotalTenths(event.deductionTenths),
        reason: event.reason,
        series: event.series ?? null,
        rule: event.rule ?? null,
        by: event.actorId,
        atUtc: event.atUtc,
      });
      break;
    }

    case EVENT_TYPES.ATHLETE_WITHDRAWN: {
      const athlete = ensureAthlete(state, event.athleteId);
      athlete.withdrawn = true;
      athlete.withdrawnReason = event.reason ?? null;
      athlete.withdrawnAtUtc = event.atUtc;
      break;
    }

    case EVENT_TYPES.SHOTS_SIGNED: {
      const athlete = ensureAthlete(state, event.athleteId);
      for (const shotId of event.shotIds) {
        athlete.signatures.set(shotId, { refereeId: event.actorId, atUtc: event.atUtc });
      }
      break;
    }

    case EVENT_TYPES.PROTEST_FILED: {
      state.protests.set(event.protestId, {
        protestId: event.protestId,
        athleteId: event.athleteId,
        againstVersionId: event.againstVersionId ?? null,
        reason: event.reason,
        filedAtUtc: event.atUtc,
        status: "OPEN",
        resolution: null,
      });
      break;
    }

    case EVENT_TYPES.PROTEST_RESOLVED: {
      const protest = state.protests.get(event.protestId);
      if (!protest) throw new Error(`申诉不存在: ${event.protestId}`);
      protest.status = "RESOLVED";
      protest.resolution = {
        verdict: event.verdict,
        note: event.note ?? null,
        atUtc: event.atUtc,
        by: event.actorId,
      };
      break;
    }

    case EVENT_TYPES.DISPLAY_SNAPSHOT_FROZEN: {
      // 现场大屏曾经显示的数字。修正只能产生新版本，永不改写本快照。
      const athlete = ensureAthlete(state, event.athleteId);
      athlete.displaySnapshots.push({
        label: event.label,
        totalTenths: toTotalTenths(event.totalTenths),
        atUtc: event.atUtc,
        basis: event.basis ?? "live-display",
      });
      break;
    }

    case EVENT_TYPES.GATE_EVIDENCE_SUBMITTED: {
      if (!state.gateEvidence) state.gateEvidence = [];
      state.gateEvidence.push({
        versionId: event.versionId,
        gate: event.gate,
        atUtc: event.atUtc,
        by: event.actorId,
        verdict: event.verdict ?? "SUBMITTED",
        reference: event.reference ?? null,
        detailHash: event.detailHash ?? null,
        note: event.note ?? null,
      });
      break;
    }

    case EVENT_TYPES.MEDIA_FLASH_PUBLISHED: {
      // 媒体快讯只是"现场曾这样播报"的记录，不构成成绩版本，更不能代替认定。
      state.flashes.push({
        flashId: event.flashId,
        athleteId: event.athleteId ?? null,
        headline: event.headline,
        claimedTotalTenths: toTotalTenths(event.claimedTotalTenths),
        atUtc: event.atUtc,
        outlet: event.outlet ?? null,
        basisVersionId: event.basisVersionId ?? null,
        basis: event.basis ?? "live-display",
      });
      break;
    }

    case EVENT_TYPES.VERSION_PUBLISHED: {
      if (state.versions.has(event.versionId)) throw new Error(`版本重复发布: ${event.versionId}`);
      const snapshot = computeResults(state, event.ruleVersionOverride ?? state.competition.ruleVersion);
      state.versions.set(event.versionId, {
        versionId: event.versionId,
        label: event.label,
        kind: event.kind ?? "STAGE_RESULT",
        atUtc: event.atUtc,
        protestDeadlineUtc: event.protestDeadlineUtc ?? null,
        protestWindowMinutes: event.protestWindowMinutes ?? null,
        publishedBy: event.actorId,
        seq: event.seq ?? state.sequence,
        results: snapshot,
      });
      state.versionOrder.push(event.versionId);
      break;
    }

    case EVENT_TYPES.VERSION_CERTIFIED: {
      if (!state.certifications) state.certifications = new Map();
      state.certifications.set(event.versionId, {
        versionId: event.versionId,
        atUtc: event.atUtc,
        by: event.actorId,
      });
      state.certifiedVersions.add(event.versionId);
      break;
    }

    case EVENT_TYPES.RECORD_RATIFIED: {
      state.ratifications.push({
        versionId: event.versionId,
        athleteId: event.athleteId,
        recordType: event.recordType,
        atUtc: event.atUtc,
        by: event.actorId,
        certificateId: event.certificateId ?? null,
      });
      break;
    }

    default:
      // 未知事件不改变状态（前向兼容），但仍保留在日志中
      break;
  }
  return state;
}

export function foldEvents(events, state = emptyState()) {
  for (const event of events) foldEvent(state, event);
  return state;
}

// ---- 成绩计算 --------------------------------------------------------------

// 靶位在 atUtc 时刻是否处于校准异常期（FAIL 之后、下一次 PASS 之前）。
function laneCalibrationSuspect(device, atUtc) {
  if (!device) return false;
  let suspect = false;
  for (const check of device.checks) {
    if (toMillis(check.atUtc) > toMillis(atUtc)) break;
    if (check.kind === "CALIBRATION") suspect = check.verdict !== "PASS";
  }
  return suspect;
}

// 选出计入成绩的弹：原始弹被作废且有对应补射弹时，以补射弹替换。
function countingShots(state, athlete) {
  const replaced = new Set();
  for (const reshot of athlete.reshots) {
    if (athlete.shots.has(reshot.replacementShotId)) replaced.add(reshot.voidedShotId);
  }
  const out = [];
  for (const shot of athlete.shots.values()) {
    const voided = athlete.voided.has(shot.shotId);
    const isReplacement = athlete.reshots.some((r) => r.replacementShotId === shot.shotId);
    if (voided && replaced.has(shot.shotId)) continue; // 原弹作废且已补射
    if (voided && !isReplacement) {
      // 已作废但补射弹尚未到达：该位置留空，计入"缺口"
      continue;
    }
    out.push(shot);
  }
  return out;
}

export function computeAthleteResult(state, athlete, ruleVersion) {
  const rule = resolveRuleVersion(ruleVersion, state.competition?.startedAtUtc);
  const seriesTotals = Array.from({ length: rule.seriesCount }, () => 0);
  const seriesShots = Array.from({ length: rule.seriesCount }, () => []);
  const device = athlete.laneId ? state.devices.get(athlete.laneId) : null;

  let subtotal = 0;
  let innerTen = 0;
  const anomalies = [];
  const seenPositions = new Set();

  for (const shot of countingShots(state, athlete)) {
    if (shot.series < 1 || shot.series > rule.seriesCount) {
      throw new Error(`弹 ${shot.shotId} 系列号越界: ${shot.series}`);
    }
    const posKey = `${shot.series}-${shot.position}`;
    if (seenPositions.has(posKey)) {
      anomalies.push({ code: "DUPLICATE_POSITION", shotId: shot.shotId });
    }
    seenPositions.add(posKey);
    if (shot.tenths > rule.maxShot) anomalies.push({ code: "OVER_MAX", shotId: shot.shotId });
    if (laneCalibrationSuspect(state.devices.get(shot.laneId ?? athlete.laneId), shot.atUtc)) {
      anomalies.push({ code: "CALIBRATION_SUSPECT", shotId: shot.shotId });
    }
    const value = Math.min(shot.tenths, rule.maxShot);
    seriesTotals[shot.series - 1] += value;
    seriesShots[shot.series - 1].push(shot);
    subtotal += value;
    if (value >= 100) innerTen += 1;
  }

  for (let s = 1; s <= rule.seriesCount; s += 1) {
    const shotsHere = countingShots(state, athlete).filter((x) => x.series === s);
    if (shotsHere.length > rule.shotsPerSeries) {
      anomalies.push({ code: "TOO_MANY_SHOTS", series: s });
    }
  }

  let deduction = 0;
  for (const penalty of athlete.penalties) {
    deduction += penalty.deductionTenths;
    if (penalty.series) seriesTotals[penalty.series - 1] -= penalty.deductionTenths;
  }

  const expectedShots = rule.seriesCount * rule.shotsPerSeries;
  const actualCount = countingShots(state, athlete).length;
  if (actualCount < expectedShots) anomalies.push({ code: "MISSING_SHOTS", expectedShots, actualCount });
  if (device) {
    const failed = device.checks.some((c) => c.kind === "CALIBRATION" && c.verdict !== "PASS");
    const recovered = [...device.checks]
      .reverse()
      .find((c) => c.kind === "CALIBRATION");
    if (failed && recovered && recovered.verdict !== "PASS") {
      anomalies.push({ code: "CALIBRATION_UNRESOLVED", laneId: device.laneId });
    }
  }

  for (const s of seriesShots) s.sort((a, b) => a.position - b.position);

  return {
    athleteId: athlete.id,
    withdrawn: athlete.withdrawn,
    ruleVersion: rule.ruleVersion,
    seriesTotals,
    seriesShots,
    subtotalTenths: subtotal,
    deductionTenths: deduction,
    totalTenths: subtotal - deduction,
    innerTen,
    shotCount: actualCount,
    anomalies,
  };
}

export function computeResults(state, ruleVersion = state.competition?.ruleVersion) {
  const results = new Map();
  for (const athlete of state.athletes.values()) {
    results.set(athlete.id, computeAthleteResult(state, athlete, ruleVersion));
  }
  return results;
}

// ---- 排名 ------------------------------------------------------------------
// 个人与团体引用同一批弹着数据（同一份 computeResults），但各自独立排名。
// 平局破除：总环 -> 内十环数 -> 末系列起逐系列倒序 -> 末发起逐发倒序。
export function rankIndividuals(results, athletes, { excludeWithdrawn = true } = {}) {
  const rows = [...results.values()]
    .filter((r) => !excludeWithdrawn || !r.withdrawn)
    .map((r) => {
      const athlete = athletes.get(r.athleteId);
      return {
        athleteId: r.athleteId,
        teamId: athlete?.teamId ?? null,
        totalTenths: r.totalTenths,
        innerTen: r.innerTen,
        seriesTotals: r.seriesTotals,
        shotSequence: r.seriesShots.flat().map((s) => s.tenths),
      };
    });
  rows.sort(compareRow);
  return rows.map((row, index) => ({ rank: index + 1, ...stripTieKeys(row) }));
}

export function rankTeams(results, teams, athletes) {
  const rows = [];
  for (const team of teams.values()) {
    const memberResults = team.memberIds
      .map((id) => results.get(id))
      .filter((r) => r && !r.withdrawn);
    if (memberResults.length === 0) continue;
    rows.push({
      teamId: team.id,
      memberIds: team.memberIds,
      totalTenths: memberResults.reduce((sum, r) => sum + r.totalTenths, 0),
      innerTen: memberResults.reduce((sum, r) => sum + r.innerTen, 0),
      memberTotals: memberResults.map((r) => r.totalTenths).sort((a, b) => b - a),
      shotSequence: memberResults
        .flatMap((r) => r.seriesShots.flat().map((s) => s.tenths))
        .sort((a, b) => b - a),
    });
  }
  rows.sort((a, b) => {
    if (b.totalTenths !== a.totalTenths) return b.totalTenths - a.totalTenths;
    if (b.innerTen !== a.innerTen) return b.innerTen - a.innerTen;
    for (let i = 0; i < Math.max(a.memberTotals.length, b.memberTotals.length); i += 1) {
      const d = (b.memberTotals[i] ?? -1) - (a.memberTotals[i] ?? -1);
      if (d !== 0) return d;
    }
    return 0;
  });
  return rows.map((row, index) => ({ rank: index + 1, ...row }));
}

function compareRow(a, b) {
  if (b.totalTenths !== a.totalTenths) return b.totalTenths - a.totalTenths;
  if (b.innerTen !== a.innerTen) return b.innerTen - a.innerTen;
  for (let i = a.seriesTotals.length - 1; i >= 0; i -= 1) {
    const d = b.seriesTotals[i] - a.seriesTotals[i];
    if (d !== 0) return d;
  }
  const seqA = a.shotSequence;
  const seqB = b.shotSequence;
  for (let i = Math.max(seqA.length, seqB.length) - 1; i >= 0; i -= 1) {
    const d = (seqB[i] ?? -1) - (seqA[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

function stripTieKeys(row) {
  const { shotSequence, ...rest } = row;
  return rest;
}
