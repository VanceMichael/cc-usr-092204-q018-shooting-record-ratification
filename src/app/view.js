import { evaluateGates, gatesSummary } from "../domain/gates.js";
import { computeResults, rankIndividuals, rankTeams } from "../domain/aggregate.js";
import { formatRing, formatTotal } from "../domain/rules.js";
import { formatInstant } from "../domain/clock.js";
import { ROLES } from "./roles.js";

// 观众可见三态（外加已被取代版本的历史态）。
export const STATUS = Object.freeze({
  PROVISIONAL: "PROVISIONAL", // 临时：电子靶实时累计，未经裁判复核
  PENDING_CONFIRMATION: "PENDING_CONFIRMATION", // 待确认：已成版本，门禁/申诉窗口未完
  OFFICIAL: "OFFICIAL", // 正式：技术代表认证的唯一正式版本
  SUPERSEDED: "SUPERSEDED", // 历史版本：被新版本取代，显示结果仍保留
});

export const STATUS_LABELS = Object.freeze({
  PROVISIONAL: "临时",
  PENDING_CONFIRMATION: "待确认",
  OFFICIAL: "正式",
  SUPERSEDED: "已被取代",
});

const OFFICIAL_ROLES = new Set([ROLES.REFEREE, ROLES.JURY, ROLES.TECHNICAL_DELEGATE]);

export function versionStatus(state, versionId, nowUtc = new Date().toISOString()) {
  if (state.certifiedVersions.has(versionId)) return STATUS.OFFICIAL;
  const index = state.versionOrder.indexOf(versionId);
  if (index < state.versionOrder.length - 1) return STATUS.SUPERSEDED;
  // 最新未认证版本：评估门禁，让"待确认"带上卡点，但不改变三态。
  const version = state.versions.get(versionId);
  const gates = evaluateGates(state, version, { nowUtc });
  return { status: STATUS.PENDING_CONFIRMATION, gates };
}

// 实时（尚未发版）的临时成绩。
function provisionalBoard(state) {
  if (!state.competition) return null;
  const results = computeResults(state);
  const individuals = rankIndividuals(results, state.athletes);
  const teams = rankTeams(results, state.teams, state.athletes);
  return {
    status: STATUS.PROVISIONAL,
    statusLabel: STATUS_LABELS[STATUS.PROVISIONAL],
    note: "电子靶实时累计，未经裁判复核与门禁确认，不构成成绩",
    individuals: individuals.map((row) => ({
      athleteId: row.athleteId,
      name: state.athletes.get(row.athleteId)?.displayName ?? null,
      bib: state.athletes.get(row.athleteId)?.bib ?? null,
      rank: row.rank,
      total: formatTotal(row.totalTenths),
      totalTenths: row.totalTenths,
      innerTen: row.innerTen,
    })),
    teams: teams.map((row) => ({
      rank: row.rank,
      teamId: row.teamId,
      name: state.teams.get(row.teamId)?.displayName ?? null,
      total: formatTotal(row.totalTenths),
    })),
  };
}

// 主记分板：优先展示最新版本；尚无版本时展示临时实时盘。
export function buildScoreboard(state, options = {}) {
  const nowUtc = options.nowUtc ?? new Date().toISOString();
  if (!state.competition) return { competition: null, board: provisionalBoard(state) };

  const timezone = state.competition.timezone;
  if (state.versionOrder.length === 0) {
    return {
      competition: competitionView(state.competition),
      timezone,
      board: provisionalBoard(state),
      versions: [],
    };
  }

  const latestId = state.versionOrder.at(-1);
  const latest = state.versions.get(latestId);
  const statusInfo = versionStatus(state, latestId, nowUtc);
  const gates = statusInfo.gates ?? evaluateGates(state, latest, { nowUtc });
  const individuals = rankIndividuals(latest.results, state.athletes);
  const teams = rankTeams(latest.results, state.teams, state.athletes);
  const ratification = state.ratifications.find((r) => r.versionId === latestId) ?? null;
  const officialId = [...state.certifiedVersions][0] ?? null;
  const officialVersion = officialId ? state.versions.get(officialId) : null;

  return {
    competition: competitionView(state.competition),
    timezone,
    board: {
      versionId: latestId,
      label: latest.label,
      status: typeof statusInfo === "string" ? statusInfo : statusInfo.status,
      statusLabel: STATUS_LABELS[typeof statusInfo === "string" ? statusInfo : statusInfo.status],
      publishedAt: formatInstant(latest.atUtc, timezone),
      protestDeadline: latest.protestDeadlineUtc
        ? formatInstant(latest.protestDeadlineUtc, timezone)
        : null,
      protestDeadlineUtc: latest.protestDeadlineUtc,
      gates: gatesSummary(gates),
      individuals: individuals.map((row) => {
        const result = latest.results.get(row.athleteId);
        return {
          athleteId: row.athleteId,
          name: state.athletes.get(row.athleteId)?.displayName ?? null,
          bib: state.athletes.get(row.athleteId)?.bib ?? null,
          rank: row.rank,
          total: formatTotal(row.totalTenths),
          innerTen: row.innerTen,
          series: row.seriesTotals.map((t) => formatTotal(t)),
          withdrawn: result.withdrawn,
          record:
            ratification?.athleteId === row.athleteId
              ? { type: ratification.recordType, ratifiedAt: formatInstant(ratification.atUtc, timezone) }
              : null,
        };
      }),
      teams: teams.map((row) => ({
        rank: row.rank,
        teamId: row.teamId,
        name: state.teams.get(row.teamId)?.displayName ?? null,
        total: formatTotal(row.totalTenths),
      })),
    },
    // 媒体快讯与正式数字的对照：快讯永远不升为成绩。
    flashes: state.flashes.map((f) => ({
      headline: f.headline,
      outlet: f.outlet,
      claimed: formatTotal(f.claimedTotalTenths),
      at: formatInstant(f.atUtc, timezone),
      matchesOfficial:
        officialVersion != null &&
        f.athleteId != null &&
        officialVersion.results.get(f.athleteId)?.totalTenths === f.claimedTotalTenths,
      advisory: "媒体快讯不构成正式认定",
    })),
    versions: state.versionOrder.map((id) => {
      const info = versionStatus(state, id, nowUtc);
      const v = state.versions.get(id);
      return {
        versionId: id,
        label: v.label,
        status: typeof info === "string" ? info : info.status,
        statusLabel: STATUS_LABELS[typeof info === "string" ? info : info.status],
        at: formatInstant(v.atUtc, timezone),
      };
    }),
  };
}

function competitionView(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    discipline: c.discipline,
    ruleVersion: c.ruleVersion,
    timezone: c.timezone,
    venue: c.venue,
    startedAtUtc: c.startedAtUtc,
  };
}

// ---- 角色化字段开放 ---------------------------------------------------------
// 观众/媒体：姓名、号码布、环值、排名、状态。
// 运动员：仅本人附加弹级明细；他人只看公开字段。
// 裁判/仲裁/技术代表：靶位、设备序列、校准漂移、器材检查细节等全部开放。
export function projectAthleteView(state, athleteId, viewer) {
  const athlete = state.athletes.get(athleteId);
  if (!athlete) return null;
  const role = viewer?.role ?? ROLES.SPECTATOR;
  const isOfficial = OFFICIAL_ROLES.has(role);
  const isSelf = role === ROLES.ATHLETE && viewer.athleteId === athleteId;

  // 公开信息：标识/号码布/姓名/弃权状态（大屏上本来就公开）。
  const base = {
    athleteId: athlete.id,
    name: athlete.displayName,
    bib: athlete.bib,
    withdrawn: athlete.withdrawn,
  };
  if (!isOfficial && !isSelf) {
    // 观众/媒体/其他运动员：看不到弹级数据与器材细节。
    return { ...base, detailVisibility: "仅限官方角色或本人" };
  }

  const detail = {
    ...base,
    laneId: athlete.laneId,
    equipmentCheck: athlete.equipmentCheck
      ? sanitizeEquipment(athlete.equipmentCheck, isOfficial)
      : null,
    shots: [...athlete.shots.values()].map((s) => ({
      shotId: s.shotId,
      series: s.series,
      position: s.position,
      ring: formatRing(s.tenths),
      voided: athlete.voided.has(s.shotId),
      signed: athlete.signatures.has(s.shotId),
      atUtc: s.atUtc,
    })),
    displaySnapshots: athlete.displaySnapshots,
  };
  if (isOfficial) {
    detail.device = deviceView(state, athlete.laneId);
    detail.shots = [...athlete.shots.values()].map((s) => ({
      shotId: s.shotId,
      series: s.series,
      position: s.position,
      ring: formatRing(s.tenths),
      rawRing: s.rawTenths == null ? null : formatRing(s.rawTenths),
      deviceId: s.deviceId,
      voided: athlete.voided.has(s.shotId) ? athlete.voided.get(s.shotId) : null,
      signed: athlete.signatures.get(s.shotId) ?? null,
      atUtc: s.atUtc,
    }));
  }
  return detail;
}

function sanitizeEquipment(check, isOfficial) {
  // 运动员本人只知道器材检查结论，细节（含器材参数）仅对官方角色开放。
  return {
    verdict: check.verdict,
    atUtc: check.atUtc,
    findings: isOfficial ? check.findings : "*** 仅官方角色可见 ***",
  };
}

function deviceView(state, laneId) {
  const device = state.devices.get(laneId);
  if (!device) return null;
  return {
    laneId: device.laneId,
    deviceId: device.deviceId,
    model: device.model,
    serial: device.serial,
    checks: device.checks,
  };
}
