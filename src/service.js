import { randomUUID } from "node:crypto";
import { badRequest, conflict, forbidden, notFound } from "./domain/errors.js";
import { EventStore } from "./domain/store.js";
import { RecordLedger, RATIFICATION_STEPS } from "./domain/records.js";
import {
  computeAthleteScore,
  coordKey,
  individualRanking,
  projectMatch,
  teamRanking,
} from "./domain/projection.js";
import { assertShotValue, getRuleset } from "./domain/rulesets.js";
import { appealDeadline, assertZone, isAfter, parseInstant, utcNow } from "./domain/time.js";
import {
  presentIndividualRow,
  presentScorecard,
  presentTeamRow,
  presentTimeline,
  requireRole,
} from "./domain/access.js";

function requireFields(input, fields) {
  for (const field of fields) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      throw badRequest(`缺少必填字段: ${field}`);
    }
  }
}

function requireOfficial(input) {
  requireFields(input, ["officialId", "signature"]);
  return { id: input.officialId, signature: input.signature };
}

export class ShootingService {
  constructor({ clock = utcNow } = {}) {
    this.store = new EventStore();
    this.ledger = new RecordLedger();
    this.clock = clock;
  }

  #append(type, matchId, payload, official = null) {
    return this.store.append({
      id: randomUUID(),
      type,
      matchId,
      atUtc: this.clock(),
      ...(official ? { official } : {}),
      ...payload,
    });
  }

  #project(matchId) {
    const state = projectMatch(this.store.ofMatch(matchId));
    if (!state.match) throw notFound(`比赛不存在: ${matchId}`);
    return state;
  }

  #athleteOf(state, athleteId) {
    const athlete = state.athletes.get(athleteId);
    if (!athlete) throw notFound(`运动员未报名: ${athleteId}`);
    return athlete;
  }

  /** 已正式确认的成绩只能凭已成立的申诉修正。 */
  #guardOfficial(state, athleteId, appealId) {
    const scorecard = state.scorecards.get(athleteId);
    if (scorecard?.status !== "official") return;
    const appeal = appealId ? state.appeals.get(appealId) : null;
    if (!appeal || appeal.athleteId !== athleteId || appeal.status !== "upheld") {
      throw conflict("成绩已正式确认：修正必须引用已成立的申诉");
    }
  }

  registerMatch(input) {
    requireFields(input, ["rulesetId", "discipline", "category"]);
    const ruleset = getRuleset(input.rulesetId); // 固定竞赛版本
    const matchId = input.matchId ?? randomUUID();
    const venueZone = assertZone(input.venueZone ?? "Asia/Shanghai");
    this.#append("match_registered", matchId, {
      rulesetId: ruleset.id,
      discipline: input.discipline,
      category: input.category,
      recordLevels: input.recordLevels ?? [],
      venueZone,
      scheduledStartUtc: input.scheduledStartUtc
        ? parseInstant(input.scheduledStartUtc, "scheduledStartUtc")
        : null,
    });
    return { matchId, ruleset };
  }

  enterAthlete(matchId, input) {
    requireFields(input, ["displayName"]);
    const state = this.#project(matchId);
    const athleteId = input.athleteId ?? randomUUID();
    if (state.athletes.has(athleteId)) throw conflict(`运动员编号已存在: ${athleteId}`);
    this.#append("athlete_entered", matchId, {
      athleteId,
      displayName: input.displayName,
      teamId: input.teamId ?? null,
      personal: input.personal ?? {},
      equipment: input.equipment ?? {},
    });
    return { athleteId };
  }

  /** 接收电子靶原始流：设备标识、时钟偏移与击发时刻随每发保存。 */
  recordShot(matchId, input) {
    requireFields(input, ["athleteId", "targetId", "series", "shot", "value", "firedAtUtc"]);
    const state = this.#project(matchId);
    const athlete = this.#athleteOf(state, input.athleteId);
    if (athlete.status === "withdrawn") throw conflict("运动员已弃权，不能再记录发弹");
    const ruleset = state.ruleset;
    for (const field of ["series", "shot"]) {
      if (!Number.isInteger(input[field])) throw badRequest(`${field} 必须是整数`);
    }
    if (input.series < 1 || input.series > ruleset.seriesCount) {
      throw badRequest(`组序超出范围 1 – ${ruleset.seriesCount}`);
    }
    if (input.shot < 1 || input.shot > ruleset.shotsPerSeries) {
      throw badRequest(`发序超出范围 1 – ${ruleset.shotsPerSeries}`);
    }
    assertShotValue(ruleset, input.value);
    const device = input.device ?? {};
    requireFields(device, ["id"]);
    if (typeof device.clockOffsetMs !== "number") {
      throw badRequest("缺少设备时钟偏移 device.clockOffsetMs");
    }
    const key = coordKey(input.athleteId, input.series, input.shot);
    const atCoord = state.shots.filter(
      (shot) => coordKey(shot.athleteId, shot.series, shot.shot) === key,
    );
    if (atCoord.some((shot) => !shot.voided)) throw conflict("该坐标已有有效发弹");
    if (atCoord.length > 0 && !state.reshootAuthorizations.has(key)) {
      throw conflict("该坐标发弹已作废，须先获准补射");
    }
    const stored = this.#append("shot_recorded", matchId, {
      athleteId: input.athleteId,
      targetId: input.targetId,
      series: input.series,
      shot: input.shot,
      value: input.value,
      firedAtUtc: parseInstant(input.firedAtUtc, "firedAtUtc"),
      deviceId: device.id,
      deviceClockOffsetMs: device.clockOffsetMs,
    });
    return { eventId: stored.id, seq: stored.seq };
  }

  /** 追加式修正：校准异常、作废、补射、判罚、弃权，均不改写历史。 */
  correct(matchId, input) {
    requireFields(input, ["type"]);
    const state = this.#project(matchId);
    const official = requireOfficial(input);

    if (input.type === "calibration_anomaly") {
      requireFields(input, ["targetId", "detail"]);
      const stored = this.#append(
        "calibration_anomaly_reported",
        matchId,
        {
          targetId: input.targetId,
          detail: input.detail,
          observedAtUtc: input.observedAtUtc
            ? parseInstant(input.observedAtUtc, "observedAtUtc")
            : this.clock(),
        },
        official,
      );
      return { eventId: stored.id };
    }

    requireFields(input, ["athleteId"]);
    this.#athleteOf(state, input.athleteId);
    this.#guardOfficial(state, input.athleteId, input.appealId);

    if (input.type === "shot_void" || input.type === "reshoot") {
      requireFields(input, ["series", "shot", "reason"]);
      const shot = state.shots.find(
        (candidate) =>
          !candidate.voided &&
          coordKey(candidate.athleteId, candidate.series, candidate.shot) ===
            coordKey(input.athleteId, input.series, input.shot),
      );
      if (!shot) throw notFound("该坐标没有可处置的有效发弹");
      const type = input.type === "reshoot" ? "reshoot_authorized" : "shot_voided";
      const stored = this.#append(
        type,
        matchId,
        { athleteId: input.athleteId, series: input.series, shot: input.shot, reason: input.reason },
        official,
      );
      return { eventId: stored.id };
    }
    if (input.type === "penalty") {
      requireFields(input, ["rings", "reason"]);
      if (typeof input.rings !== "number" || input.rings <= 0) {
        throw badRequest("判罚环值必须为正数");
      }
      const stored = this.#append(
        "penalty_applied",
        matchId,
        {
          athleteId: input.athleteId,
          rings: input.rings,
          reason: input.reason,
          ruleRef: input.ruleRef ?? null,
        },
        official,
      );
      return { eventId: stored.id };
    }
    if (input.type === "withdrawal") {
      requireFields(input, ["reason"]);
      const stored = this.#append(
        "athlete_withdrawn",
        matchId,
        { athleteId: input.athleteId, reason: input.reason },
        official,
      );
      return { eventId: stored.id };
    }
    throw badRequest(`未知修正类型: ${input.type}`);
  }

  /** 裁判提交复核：成绩进入待确认。并发复核以版本号互斥。 */
  reviewScorecard(matchId, athleteId, input) {
    const state = this.#project(matchId);
    this.#athleteOf(state, athleteId);
    const official = requireOfficial(input);
    const scorecard = state.scorecards.get(athleteId);
    if (scorecard.status !== "provisional") {
      throw conflict(`当前状态不可提交复核: ${scorecard.status}`);
    }
    const current = scorecard.versions[scorecard.versions.length - 1];
    if (!current) throw conflict("尚无可复核的成绩版本");
    if (input.expectedVersion !== current.version) {
      throw conflict(`成绩版本已变化（当前 ${current.version}），请重新复核`);
    }
    this.#append("scorecard_review_submitted", matchId, { athleteId, version: current.version }, official);
    return { status: "pending_confirmation", version: current.version };
  }

  /**
   * 确认正式版本：同一版本只允许一次确认成功，
   * 并发确认中后到者收到冲突，保证只形成一个正式版本。
   */
  confirmScorecard(matchId, athleteId, input) {
    const state = this.#project(matchId);
    this.#athleteOf(state, athleteId);
    const official = requireOfficial(input);
    const scorecard = state.scorecards.get(athleteId);
    if (scorecard.status !== "pending_confirmation") {
      throw conflict(`只能形成一个正式版本：当前状态为 ${scorecard.status}`);
    }
    const current = scorecard.versions[scorecard.versions.length - 1];
    if (input.expectedVersion !== current.version || scorecard.review?.version !== current.version) {
      throw conflict("复核版本与当前版本不一致，请重新复核");
    }
    const stored = this.#append(
      "scorecard_confirmed",
      matchId,
      { athleteId, version: current.version },
      official,
    );

    // 正式总环值超过现行纪录 → 登记纪录候选（媒体快讯无此效力）
    const candidates = [];
    for (const level of state.match.recordLevels) {
      const candidate = this.ledger.consider({
        discipline: state.match.discipline,
        category: state.match.category,
        level,
        athleteId,
        matchId,
        total: current.total,
        scorecardVersion: current.version,
        officialAtUtc: stored.atUtc,
        appealDeadlineUtc: appealDeadline(stored.atUtc, state.ruleset.appealWindowMinutes),
      });
      if (candidate) candidates.push(candidate);
    }
    return { status: "official", version: current.version, candidates };
  }

  /** 申诉必须在正式确认后的窗口内提出。 */
  fileAppeal(matchId, input) {
    requireFields(input, ["athleteId", "reason"]);
    const state = this.#project(matchId);
    this.#athleteOf(state, input.athleteId);
    const scorecard = state.scorecards.get(input.athleteId);
    const officialAt = scorecard?.official?.atUtc ?? scorecard?.supersededOfficial?.atUtc;
    if (!officialAt) throw badRequest("成绩尚未正式确认，不能提出申诉");
    const filedAtUtc = input.filedAtUtc ? parseInstant(input.filedAtUtc, "filedAtUtc") : this.clock();
    const deadline = appealDeadline(officialAt, state.ruleset.appealWindowMinutes);
    if (isAfter(filedAtUtc, deadline)) {
      throw badRequest(`超过申诉截止时间 ${deadline}`);
    }
    const appealId = randomUUID();
    this.#append("appeal_filed", matchId, { appealId, athleteId: input.athleteId, reason: input.reason, filedAtUtc });
    return { appealId, appealDeadlineUtc: deadline };
  }

  resolveAppeal(matchId, appealId, input) {
    requireFields(input, ["outcome"]);
    const state = this.#project(matchId);
    const official = requireOfficial(input);
    const appeal = state.appeals.get(appealId);
    if (!appeal) throw notFound(`申诉不存在: ${appealId}`);
    if (appeal.status !== "open") throw conflict("申诉已结案");
    if (!["upheld", "dismissed"].includes(input.outcome)) {
      throw badRequest("outcome 必须是 upheld 或 dismissed");
    }
    this.#append(
      "appeal_resolved",
      matchId,
      { appealId, outcome: input.outcome, resolution: input.resolution ?? null },
      official,
    );
    return { appealId, status: input.outcome };
  }

  scorecards(matchId, role) {
    requireRole(role);
    const state = this.#project(matchId);
    return [...state.scorecards.keys()].map((athleteId) => presentScorecard(role, state, athleteId));
  }

  scorecard(matchId, athleteId, role) {
    requireRole(role);
    const state = this.#project(matchId);
    const view = presentScorecard(role, state, athleteId);
    if (!view) throw notFound(`成绩不存在: ${athleteId}`);
    return view;
  }

  rankings(matchId, kind, role) {
    requireRole(role);
    const state = this.#project(matchId);
    if (kind === "individual") {
      return individualRanking(state).map((row) => presentIndividualRow(role, state, row));
    }
    if (kind === "team") {
      return teamRanking(state).map((row) => presentTeamRow(role, state, row));
    }
    throw badRequest(`未知排名类型: ${kind}`);
  }

  timeline(matchId, role, zone) {
    requireRole(role);
    const state = this.#project(matchId);
    return presentTimeline(state, zone ? assertZone(zone) : undefined);
  }

  records(role) {
    requireRole(role);
    const all = this.ledger.list();
    const visible = role === "audience" ? all.filter((c) => c.status === "ratified") : all;
    return visible.map((candidate) => {
      const base = {
        id: candidate.id,
        discipline: candidate.discipline,
        category: candidate.category,
        level: candidate.level,
        athleteId: candidate.athleteId,
        matchId: candidate.matchId,
        total: candidate.total,
        status: candidate.status,
        officialAtUtc: candidate.officialAtUtc,
        appealDeadlineUtc: candidate.appealDeadlineUtc,
        ratifiedAtUtc: candidate.ratifiedAtUtc,
        steps: RATIFICATION_STEPS.map((step) => ({ step, done: Boolean(candidate.approvals[step]) })),
      };
      return role === "audience" ? base : { ...base, approvals: candidate.approvals };
    });
  }

  /** 认定链上的每一环都由技术代表确认；申诉窗口须确实关闭。 */
  approveRecordStep(candidateId, input, role) {
    if (role !== "technical_delegate") throw forbidden("只有技术代表能确认认定环节");
    requireFields(input, ["step", "officialId", "signature"]);
    const candidate = this.ledger.get(candidateId);
    if (input.step === "appeal_window") {
      if (!isAfter(this.clock(), candidate.appealDeadlineUtc)) {
        throw conflict(`申诉窗口尚未关闭（截止 ${candidate.appealDeadlineUtc}）`);
      }
      const state = this.#project(candidate.matchId);
      const open = [...state.appeals.values()].filter(
        (appeal) => appeal.athleteId === candidate.athleteId && appeal.status === "open",
      );
      if (open.length > 0) throw conflict("存在未结申诉，不能确认申诉窗口关闭");
    }
    return this.ledger.approve(
      candidateId,
      input.step,
      { id: input.officialId, signature: input.signature },
      this.clock(),
    );
  }

  /**
   * 技术代表重放：从一项纪录回溯全部发弹、修正、校准、
   * 版本与批准证据，并重算到被确认版本核对一致性。
   */
  replayRecord(candidateId, role) {
    if (role !== "technical_delegate") throw forbidden("只有技术代表能重放认定证据");
    const candidate = this.ledger.get(candidateId);
    const events = this.store.ofMatch(candidate.matchId);
    const state = projectMatch(events);

    const confirmation = events.find(
      (event) =>
        event.type === "scorecard_confirmed" &&
        event.athleteId === candidate.athleteId &&
        event.version === candidate.scorecardVersion,
    );
    let recomputation = null;
    if (confirmation) {
      const replayed = projectMatch(events.filter((event) => event.seq <= confirmation.seq));
      const recomputed = computeAthleteScore(replayed, candidate.athleteId);
      recomputation = {
        upToSeq: confirmation.seq,
        total: recomputed.total,
        consistent: recomputed.total === candidate.total,
      };
    }

    const scorecard = state.scorecards.get(candidate.athleteId);
    return {
      candidate,
      rulesetId: state.match.rulesetId,
      scorecardVersions: scorecard?.versions ?? [],
      shots: state.shots
        .filter((shot) => shot.athleteId === candidate.athleteId)
        .sort((a, b) => a.series - b.series || a.shot - b.shot || a.seq - b.seq),
      penalties: state.penalties.filter((penalty) => penalty.athleteId === candidate.athleteId),
      calibrationReports: state.calibrationReports,
      appeals: [...state.appeals.values()].filter((appeal) => appeal.athleteId === candidate.athleteId),
      approvals: candidate.approvals,
      recomputation,
    };
  }
}
