import { forbidden } from "./errors.js";
import { inZone } from "./time.js";

/**
 * 角色化视图：运动员隐私与器材细节按角色开放。
 * audience           观众/媒体：名次、环值、状态，无隐私与器材细节
 * referee            裁判：每发数据、复核签名、器材概要
 * technical_delegate 技术代表：全部细节，含设备时钟、校准报告、申诉与认定证据
 */
export const ROLES = ["audience", "referee", "technical_delegate"];

export const STATUS_LABELS = {
  provisional: "临时",
  pending_confirmation: "待确认",
  official: "正式",
};

export function requireRole(role) {
  if (!ROLES.includes(role)) throw forbidden(`未知角色: ${role}`);
  return role;
}

export function presentAthlete(role, athlete) {
  const base = {
    athleteId: athlete.athleteId,
    displayName: athlete.displayName,
    teamId: athlete.teamId,
    status: athlete.status,
  };
  if (role === "audience") return base;
  if (role === "referee") {
    const { make, model } = athlete.equipment ?? {};
    return { ...base, equipment: { make, model } };
  }
  return { ...base, personal: athlete.personal, equipment: athlete.equipment };
}

export function presentShot(role, shot) {
  const base = {
    series: shot.series,
    shot: shot.shot,
    value: shot.value,
    reshoot: shot.reshoot,
  };
  if (role === "audience") return base;
  const officialView = {
    ...base,
    targetId: shot.targetId,
    voided: shot.voided,
    voidReason: shot.voidReason ?? null,
    suspect: shot.suspect,
  };
  if (role === "referee") return officialView;
  return {
    ...officialView,
    deviceId: shot.deviceId,
    deviceClockOffsetMs: shot.deviceClockOffsetMs,
    firedAtUtc: shot.firedAtUtc,
    seq: shot.seq,
  };
}

export function presentScorecard(role, state, athleteId) {
  const scorecard = state.scorecards.get(athleteId);
  const athlete = state.athletes.get(athleteId);
  if (!scorecard || !athlete) return null;
  const current = scorecard.versions[scorecard.versions.length - 1] ?? null;
  // 原始显示结果 = 首次打满全部发数时对外显示的版本；任何修正都不覆盖它
  const fullCard = (state.ruleset?.seriesCount ?? 0) * (state.ruleset?.shotsPerSeries ?? 0);
  const original =
    scorecard.versions.find((version) => fullCard > 0 && version.shotCount === fullCard) ??
    scorecard.versions[0] ??
    null;

  const base = {
    athlete: presentAthlete(role, athlete),
    status: scorecard.status,
    statusLabel: STATUS_LABELS[scorecard.status],
    version: current?.version ?? 0,
    total: current?.total ?? 0,
    penaltyRings: current?.penaltyRings ?? 0,
    series: (current?.series ?? []).map(({ index, count, total }) => ({ index, count, total })),
    // 原始显示结果始终保留，任何修正都不覆盖它
    displayedOriginally: original
      ? { total: original.total, atUtc: original.atUtc }
      : null,
  };
  if (role === "audience") return base;

  const shots = state.shots
    .filter((shot) => shot.athleteId === athleteId)
    .sort((a, b) => a.series - b.series || a.shot - b.shot || a.seq - b.seq)
    .map((shot) => presentShot(role, shot));
  const officialView = {
    ...base,
    versionCount: scorecard.versions.length,
    shots,
    versions: scorecard.versions,
    review: scorecard.review,
    official: scorecard.official,
    supersededOfficial: scorecard.supersededOfficial,
  };
  if (role === "referee") return officialView;

  return {
    ...officialView,
    calibrationReports: state.calibrationReports,
    appeals: [...state.appeals.values()].filter((appeal) => appeal.athleteId === athleteId),
  };
}

/** 观众时间线：清晰的临时/待确认/正式状态，发布与申诉截止按指定时区显示。 */
export function presentTimeline(state, zone) {
  const resolvedZone = zone ?? state.match?.venueZone ?? "UTC";
  const rows = [];
  for (const [athleteId, scorecard] of state.scorecards) {
    const athlete = state.athletes.get(athleteId);
    const current = scorecard.versions[scorecard.versions.length - 1] ?? null;
    if (!athlete || !current) continue;
    const officialAt = scorecard.official?.atUtc ?? scorecard.supersededOfficial?.atUtc ?? null;
    const deadline = officialAt
      ? new Date(
          new Date(officialAt).getTime() + (state.ruleset?.appealWindowMinutes ?? 0) * 60_000,
        ).toISOString()
      : null;
    rows.push({
      athleteId,
      displayName: athlete.displayName,
      teamId: athlete.teamId,
      status: scorecard.status,
      statusLabel: STATUS_LABELS[scorecard.status],
      total: current.total,
      version: current.version,
      officialAtUtc: officialAt,
      officialAtLocal: officialAt ? inZone(officialAt, resolvedZone) : null,
      appealDeadlineUtc: deadline,
      appealDeadlineLocal: deadline ? inZone(deadline, resolvedZone) : null,
      zone: resolvedZone,
    });
  }
  return rows.sort((a, b) => b.total - a.total || a.athleteId.localeCompare(b.athleteId));
}

export function presentIndividualRow(role, state, row) {
  const athlete = state.athletes.get(row.athleteId);
  const base = {
    rank: row.rank ?? null,
    athleteId: row.athleteId,
    displayName: athlete?.displayName ?? null,
    teamId: row.teamId,
    total: row.total,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status],
    withdrawn: row.withdrawn,
  };
  if (role === "audience") return base;
  return { ...base, version: row.version, shotCount: row.shotCount, lastSeriesTotal: row.lastSeriesTotal };
}

export function presentTeamRow(role, state, row) {
  const members = row.members.map((member) => {
    const athlete = state.athletes.get(member.athleteId);
    return { athleteId: member.athleteId, displayName: athlete?.displayName ?? null, total: member.total };
  });
  const base = { rank: row.rank, teamId: row.teamId, total: row.total, complete: row.complete, members };
  if (role === "audience") return base;
  return { ...base };
}
