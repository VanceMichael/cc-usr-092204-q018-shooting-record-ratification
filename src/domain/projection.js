import { getRuleset, round1 } from "./rulesets.js";

/**
 * 把一场比赛的事件流折叠为当前状态。
 * 成绩以“版本”形式累计：每个影响成绩的事件都会生成一个新版本，
 * 历史版本（含首次对外显示的原始结果）全部保留。
 */
export function projectMatch(events) {
  const state = {
    match: null,
    ruleset: null,
    athletes: new Map(), // athleteId -> { displayName, teamId, personal, equipment, status }
    shots: [], // 全部发弹（含已作废与被补射替换的），一律保留
    reshootAuthorizations: new Set(), // 已获准补射的坐标
    penalties: [],
    calibrationReports: [],
    appeals: new Map(), // appealId -> appeal
    scorecards: new Map(), // athleteId -> { status, versions, review, official, supersededOfficial }
  };
  for (const event of events) applyEvent(state, event);
  return state;
}

export const coordKey = (athleteId, series, shot) => `${athleteId}#${series}#${shot}`;

function ensureScorecard(state, athleteId) {
  let scorecard = state.scorecards.get(athleteId);
  if (!scorecard) {
    scorecard = {
      athleteId,
      status: "provisional", // provisional | pending_confirmation | official
      versions: [],
      review: null,
      official: null,
      supersededOfficial: null,
    };
    state.scorecards.set(athleteId, scorecard);
  }
  return scorecard;
}

function applyEvent(state, event) {
  switch (event.type) {
    case "match_registered": {
      state.match = {
        id: event.matchId,
        rulesetId: event.rulesetId,
        discipline: event.discipline,
        category: event.category,
        recordLevels: event.recordLevels ?? [],
        venueZone: event.venueZone,
        scheduledStartUtc: event.scheduledStartUtc ?? null,
      };
      state.ruleset = getRuleset(event.rulesetId);
      break;
    }
    case "athlete_entered": {
      state.athletes.set(event.athleteId, {
        athleteId: event.athleteId,
        displayName: event.displayName,
        teamId: event.teamId ?? null,
        personal: event.personal ?? {},
        equipment: event.equipment ?? {},
        status: "active",
      });
      ensureScorecard(state, event.athleteId);
      break;
    }
    case "shot_recorded": {
      const key = coordKey(event.athleteId, event.series, event.shot);
      state.shots.push({
        athleteId: event.athleteId,
        series: event.series,
        shot: event.shot,
        value: event.value,
        targetId: event.targetId,
        deviceId: event.deviceId,
        deviceClockOffsetMs: event.deviceClockOffsetMs,
        firedAtUtc: event.firedAtUtc,
        seq: event.seq,
        voided: false,
        reshoot: state.reshootAuthorizations.delete(key),
        suspect: false,
      });
      bump(state, event.athleteId, event);
      break;
    }
    case "shot_voided":
    case "reshoot_authorized": {
      const key = coordKey(event.athleteId, event.series, event.shot);
      const shot = state.shots.find(
        (candidate) =>
          !candidate.voided && coordKey(candidate.athleteId, candidate.series, candidate.shot) === key,
      );
      if (shot) {
        shot.voided = true;
        shot.voidReason = event.reason;
        shot.voidedBy = event.official ?? null;
      }
      if (event.type === "reshoot_authorized") state.reshootAuthorizations.add(key);
      bump(state, event.athleteId, event);
      break;
    }
    case "penalty_applied": {
      state.penalties.push({
        athleteId: event.athleteId,
        rings: event.rings,
        reason: event.reason,
        ruleRef: event.ruleRef ?? null,
        official: event.official ?? null,
        seq: event.seq,
      });
      bump(state, event.athleteId, event);
      break;
    }
    case "athlete_withdrawn": {
      const athlete = state.athletes.get(event.athleteId);
      if (athlete) {
        athlete.status = "withdrawn";
        athlete.withdrawReason = event.reason;
      }
      bump(state, event.athleteId, event);
      break;
    }
    case "calibration_anomaly_reported": {
      state.calibrationReports.push({
        targetId: event.targetId,
        detail: event.detail,
        observedAtUtc: event.observedAtUtc,
        reportedBy: event.official ?? null,
        seq: event.seq,
      });
      // 该靶位上的已记录发弹标记为可疑，等待技术代表处置
      for (const shot of state.shots.values()) {
        if (shot.targetId === event.targetId) shot.suspect = true;
      }
      break;
    }
    case "scorecard_review_submitted": {
      const scorecard = ensureScorecard(state, event.athleteId);
      scorecard.status = "pending_confirmation";
      scorecard.review = {
        refereeId: event.official?.id ?? null,
        signature: event.official?.signature ?? null,
        version: event.version,
        atUtc: event.atUtc,
      };
      break;
    }
    case "scorecard_confirmed": {
      const scorecard = ensureScorecard(state, event.athleteId);
      scorecard.status = "official";
      scorecard.official = {
        refereeId: event.official?.id ?? null,
        signature: event.official?.signature ?? null,
        version: event.version,
        atUtc: event.atUtc,
      };
      break;
    }
    case "appeal_filed": {
      state.appeals.set(event.appealId, {
        id: event.appealId,
        athleteId: event.athleteId,
        reason: event.reason,
        filedAtUtc: event.filedAtUtc,
        status: "open",
      });
      break;
    }
    case "appeal_resolved": {
      const appeal = state.appeals.get(event.appealId);
      if (appeal) {
        appeal.status = event.outcome === "upheld" ? "upheld" : "dismissed";
        appeal.resolution = event.resolution ?? null;
        appeal.resolvedAtUtc = event.atUtc;
        appeal.resolvedBy = event.official ?? null;
      }
      break;
    }
    default:
      break;
  }
}

/**
 * 生成成绩新版本。若成绩已处于待确认/正式状态，修正事件会把它
 * 退回“临时”状态（正式确认记录移入 supersededOfficial 保留），
 * 必须重新复核、重新确认。
 */
function bump(state, athleteId, cause) {
  const scorecard = ensureScorecard(state, athleteId);
  if (scorecard.status !== "provisional") {
    if (scorecard.status === "official") scorecard.supersededOfficial = scorecard.official;
    scorecard.status = "provisional";
    scorecard.review = null;
    scorecard.official = null;
  }
  const computed = computeAthleteScore(state, athleteId);
  scorecard.versions.push({
    version: scorecard.versions.length + 1,
    atSeq: cause.seq,
    atUtc: cause.atUtc,
    cause: cause.type,
    ...computed,
  });
}

/** 按比赛固定的竞赛版本计算分项与总环值。 */
export function computeAthleteScore(state, athleteId) {
  const ruleset = state.ruleset;
  const active = state.shots
    .filter((shot) => shot.athleteId === athleteId && !shot.voided)
    .sort((a, b) => a.series - b.series || a.shot - b.shot);

  const series = [];
  for (let index = 1; index <= ruleset.seriesCount; index += 1) {
    const inSeries = active.filter((shot) => shot.series === index);
    series.push({
      index,
      count: inSeries.length,
      shots: inSeries.map((shot) => shot.value),
      total: round1(inSeries.reduce((sum, shot) => sum + shot.value, 0)),
    });
  }

  const shotsTotal = round1(series.reduce((sum, part) => sum + part.total, 0));
  const penaltyRings = round1(
    state.penalties
      .filter((penalty) => penalty.athleteId === athleteId)
      .reduce((sum, penalty) => sum + penalty.rings, 0),
  );
  return {
    series,
    shotCount: active.length,
    shotsTotal,
    penaltyRings,
    total: round1(shotsTotal - penaltyRings),
  };
}

function currentVersion(scorecard) {
  return scorecard.versions[scorecard.versions.length - 1] ?? null;
}

/** 个人排名：引用发弹数据计算，独立于团体排名。弃权者列末且不排名。 */
export function individualRanking(state) {
  const rows = [];
  for (const [athleteId, scorecard] of state.scorecards) {
    const athlete = state.athletes.get(athleteId);
    const current = currentVersion(scorecard);
    if (!athlete || !current) continue;
    rows.push({
      athleteId,
      teamId: athlete.teamId,
      status: scorecard.status,
      withdrawn: athlete.status === "withdrawn",
      total: current.total,
      shotCount: current.shotCount,
      lastSeriesTotal: current.series[current.series.length - 1]?.total ?? 0,
      version: current.version,
    });
  }
  const rankable = rows
    .filter((row) => !row.withdrawn)
    .sort(
      (a, b) =>
        b.total - a.total ||
        b.lastSeriesTotal - a.lastSeriesTotal ||
        a.athleteId.localeCompare(b.athleteId),
    );
  rankable.forEach((row, index) => {
    row.rank = index + 1;
  });
  return [...rankable, ...rows.filter((row) => row.withdrawn)];
}

/** 团体排名：与个人排名引用同一发弹数据，但构成独立的排名序列。 */
export function teamRanking(state) {
  const teams = new Map();
  for (const row of individualRanking(state)) {
    if (row.withdrawn || !row.teamId) continue;
    let team = teams.get(row.teamId);
    if (!team) {
      team = { teamId: row.teamId, members: [], total: 0 };
      teams.set(row.teamId, team);
    }
    team.members.push({ athleteId: row.athleteId, total: row.total });
    team.total = round1(team.total + row.total);
  }
  const size = state.ruleset?.teamSize ?? 3;
  const rows = [...teams.values()].map((team) => ({
    ...team,
    complete: team.members.length === size,
  }));
  rows.sort((a, b) => b.total - a.total || a.teamId.localeCompare(b.teamId));
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });
  return rows;
}
