import { EventStore } from "../domain/store.js";
import { createEvent, EVENT_TYPES } from "../domain/events.js";
import { evaluateGates, gatesAllPassed, GATES } from "../domain/gates.js";
import { toMillis } from "../domain/clock.js";
import { DomainError, ROLES } from "./roles.js";

const DEFAULT_PROTEST_WINDOW_MINUTES = 10;

// 应用服务：全部写操作经事件追加完成；关键判定在 store 事务内执行，
// 使并发裁判/技术代表的操作天然串行化（CAS：先检查后落事件）。
export class CompetitionService {
  constructor(options = {}) {
    this.store = options.store ?? new EventStore();
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idCounter = 0;
  }

  #now(override) {
    return override ?? this.clock();
  }

  #id(prefix) {
    this.idCounter += 1;
    return `${prefix}-${String(this.store.length + this.idCounter).padStart(4, "0")}`;
  }

  #requireRole(actor, roles, action) {
    if (!actor?.role || !roles.includes(actor.role)) {
      throw new DomainError("FORBIDDEN", `${action} 需要角色 ${roles.join("/")}，当前为 ${actor?.role ?? "无"}`, {
        status: 403,
      });
    }
  }

  #ev(type, payload, actor, atUtc, source) {
    return createEvent(
      type,
      payload,
      { atUtc: this.#now(atUtc), actorId: actor?.id ?? null, actorRole: actor?.role ?? null, source },
    );
  }

  // ---- 赛事与实体 ----------------------------------------------------------

  async openCompetition(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "开启赛事");
    const event = this.#ev(
      EVENT_TYPES.COMPETITION_OPENED,
      {
        competitionId: input.competitionId ?? this.#id("CMP"),
        name: input.name,
        discipline: input.discipline,
        ruleVersion: input.ruleVersion,
        startedAtUtc: input.startedAtUtc,
        finishedAtUtc: input.finishedAtUtc ?? null,
        timezone: input.timezone,
        venue: input.venue ?? null,
        recordProtocol: input.recordProtocol ?? null,
      },
      actor,
      input.atUtc ?? input.startedAtUtc,
    );
    await this.store.append(event);
    return event.competitionId;
  }

  async registerAthlete(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "运动员注册");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.ATHLETE_REGISTERED,
        {
          athleteId: input.athleteId,
          displayName: input.displayName,
          bib: input.bib,
          teamId: input.teamId ?? null,
        },
        actor,
        input.atUtc,
      ),
    );
  }

  async registerTeam(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "团体注册");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.TEAM_REGISTERED,
        { teamId: input.teamId, displayName: input.displayName, memberIds: [...input.memberIds] },
        actor,
        input.atUtc,
      ),
    );
  }

  async registerLaneDevice(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "靶位设备登记");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.LANE_DEVICE_REGISTERED,
        {
          laneId: input.laneId,
          deviceId: input.deviceId,
          model: input.model ?? null,
          serial: input.serial ?? null,
        },
        actor,
        input.atUtc,
      ),
    );
  }

  async assignLane(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "靶位指派");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.ATHLETE_LANE_ASSIGNED,
        { athleteId: input.athleteId, laneId: input.laneId },
        actor,
        input.atUtc,
      ),
    );
  }

  // ---- 赛前检查 ------------------------------------------------------------

  async calibrationCheck(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "校准检查");
    if (!["PASS", "FAIL"].includes(input.verdict)) throw new DomainError("BAD_INPUT", "校准结论必须为 PASS/FAIL");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.CALIBRATION_CHECK,
        {
          laneId: input.laneId,
          verdict: input.verdict,
          driftTenths: input.driftTenths ?? 0,
          note: input.note ?? null,
        },
        actor,
        input.atUtc,
      ),
    );
  }

  async timeSyncCheck(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "时间同步检查");
    if (!["PASS", "FAIL"].includes(input.verdict)) throw new DomainError("BAD_INPUT", "同步结论必须为 PASS/FAIL");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.TIME_SYNC_CHECK,
        { verdict: input.verdict, driftMillis: input.driftMillis ?? 0, note: input.note ?? null },
        actor,
        input.atUtc,
      ),
    );
  }

  async startConfirmed(input = {}, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "开赛确认");
    await this.store.append(this.#ev(EVENT_TYPES.START_CONFIRMED, {}, actor, input.atUtc));
  }

  async equipmentCheck(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "器材检查");
    if (!["PASS", "FAIL"].includes(input.verdict)) throw new DomainError("BAD_INPUT", "器材结论必须为 PASS/FAIL");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.EQUIPMENT_CHECK,
        { athleteId: input.athleteId, verdict: input.verdict, findings: input.findings ?? null },
        actor,
        input.atUtc,
      ),
    );
  }

  // ---- 原始流与裁判签名 -----------------------------------------------------

  async recordShot(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "弹着上送");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.SHOT_RECORDED,
        {
          athleteId: input.athleteId,
          shotId: input.shotId,
          series: input.series,
          position: input.position,
          tenths: input.tenths,
          rawTenths: input.rawTenths ?? null,
          laneId: input.laneId ?? null,
          deviceId: input.deviceId ?? null,
        },
        actor,
        input.atUtc,
        input.source ?? "electronic-target",
      ),
    );
  }

  async signShots(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "裁判签名");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.SHOTS_SIGNED,
        { athleteId: input.athleteId, shotIds: [...input.shotIds] },
        actor,
        input.atUtc,
      ),
    );
  }

  // ---- 追加修正（不改原始弹）------------------------------------------------

  async voidShot(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "弹着作废");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.SHOT_VOIDED,
        {
          athleteId: input.athleteId,
          shotId: input.shotId,
          reason: input.reason,
          note: input.note ?? null,
        },
        actor,
        input.atUtc,
      ),
    );
  }

  async awardReshot(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "补射判定");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.RESHOT_AWARDED,
        {
          athleteId: input.athleteId,
          voidedShotId: input.voidedShotId,
          replacementShotId: input.replacementShotId,
          reason: input.reason ?? null,
        },
        actor,
        input.atUtc,
      ),
    );
  }

  async addPenalty(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "判罚扣分");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.PENALTY_DEDUCTED,
        {
          athleteId: input.athleteId,
          deductionTenths: input.deductionTenths,
          reason: input.reason,
          series: input.series ?? null,
          rule: input.rule ?? null,
        },
        actor,
        input.atUtc,
      ),
    );
  }

  async withdrawAthlete(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE, ROLES.JURY], "弃权登记");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.ATHLETE_WITHDRAWN,
        { athleteId: input.athleteId, reason: input.reason ?? null },
        actor,
        input.atUtc,
      ),
    );
  }

  // ---- 现场显示与媒体快讯 ---------------------------------------------------

  async freezeDisplay(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "现场显示冻结");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.DISPLAY_SNAPSHOT_FROZEN,
        {
          athleteId: input.athleteId,
          label: input.label,
          totalTenths: input.totalTenths,
          basis: input.basis ?? "live-display",
        },
        actor,
        input.atUtc,
      ),
    );
  }

  async publishFlash(input, actor) {
    this.#requireRole(actor, [ROLES.MEDIA, ROLES.REFEREE], "媒体快讯登记");
    const flashId = input.flashId ?? this.#id("FLASH");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.MEDIA_FLASH_PUBLISHED,
        {
          flashId,
          athleteId: input.athleteId ?? null,
          headline: input.headline,
          claimedTotalTenths: input.claimedTotalTenths,
          outlet: input.outlet ?? null,
          basisVersionId: input.basisVersionId ?? null,
          basis: input.basis ?? "live-display",
        },
        actor,
        input.atUtc,
      ),
    );
    return flashId;
  }

  // ---- 申诉 ----------------------------------------------------------------

  async fileProtest(input, actor) {
    if (actor.role === ROLES.ATHLETE) {
      if (input.athleteId !== actor.athleteId) {
        throw new DomainError("FORBIDDEN", "运动员只能为本人提出申诉", { status: 403 });
      }
    } else {
      this.#requireRole(actor, [ROLES.JURY], "申诉登记");
    }
    const state = this.store.replay();
    const against = input.againstVersionId ? state.versions.get(input.againstVersionId) : null;
    if (input.againstVersionId && !against) throw new DomainError("NOT_FOUND", "被申诉版本不存在", { status: 404 });
    if (against?.protestDeadlineUtc && toMillis(input.atUtc ?? this.clock()) > toMillis(against.protestDeadlineUtc)) {
      throw new DomainError("PROTEST_WINDOW_CLOSED", "申诉窗口已关闭，不予受理", {
        status: 409,
        deadlineUtc: against.protestDeadlineUtc,
      });
    }
    const protestId = input.protestId ?? this.#id("PRT");
    await this.store.append(
      this.#ev(
        EVENT_TYPES.PROTEST_FILED,
        {
          protestId,
          athleteId: input.athleteId,
          againstVersionId: input.againstVersionId ?? null,
          reason: input.reason,
        },
        actor,
        input.atUtc,
      ),
    );
    return protestId;
  }

  async resolveProtest(input, actor) {
    this.#requireRole(actor, [ROLES.JURY], "申诉裁决");
    if (!["UPHELD", "REJECTED"].includes(input.verdict)) {
      throw new DomainError("BAD_INPUT", "裁决必须为 UPHELD/REJECTED");
    }
    await this.store.append(
      this.#ev(
        EVENT_TYPES.PROTEST_RESOLVED,
        { protestId: input.protestId, verdict: input.verdict, note: input.note ?? null },
        actor,
        input.atUtc,
      ),
    );
  }

  // ---- 成绩版本 -------------------------------------------------------------

  async publishVersion(input, actor) {
    this.#requireRole(actor, [ROLES.REFEREE], "发布成绩版本");
    const atUtc = this.#now(input.atUtc);
    const windowMinutes = input.protestWindowMinutes ?? DEFAULT_PROTEST_WINDOW_MINUTES;
    const versionId = input.versionId ?? this.#id("V");
    await this.store.transact((state) => {
      if (state.certifiedVersions.size > 0) {
        throw new DomainError(
          "OFFICIAL_LOCKED",
          `正式版本 ${[...state.certifiedVersions][0]} 已锁定，如需更正须走正式勘误程序`,
          { status: 409 },
        );
      }
      return createEvent(
        EVENT_TYPES.VERSION_PUBLISHED,
        {
          versionId,
          label: input.label,
          kind: input.kind ?? "STAGE_RESULT",
          protestWindowMinutes: windowMinutes,
          protestDeadlineUtc: new Date(toMillis(atUtc) + windowMinutes * 60000).toISOString(),
        },
        { atUtc, actorId: actor.id, actorRole: actor.role, source: "result-system" },
      );
    });
    return versionId;
  }

  async submitGateEvidence(input, actor) {
    const gate = input.gate;
    if (gate === GATES.PROTEST_WINDOW) {
      this.#requireRole(actor, [ROLES.JURY], "申诉窗口门禁签署");
    } else {
      this.#requireRole(actor, [ROLES.REFEREE], "门禁证据提交");
    }
    if (input.verdict && !["PASS", "FAIL"].includes(input.verdict)) {
      throw new DomainError("BAD_INPUT", "门禁结论必须为 PASS/FAIL");
    }
    await this.store.transact((state) => {
      if (!state.versions.has(input.versionId)) throw new DomainError("NOT_FOUND", "版本不存在", { status: 404 });
      return createEvent(
        EVENT_TYPES.GATE_EVIDENCE_SUBMITTED,
        {
          versionId: input.versionId,
          gate,
          verdict: input.verdict ?? "SUBMITTED",
          reference: input.reference ?? null,
          detailHash: input.detailHash ?? null,
          note: input.note ?? null,
        },
        { atUtc: this.#now(input.atUtc), actorId: actor.id, actorRole: actor.role, source: "jury-paperwork" },
      );
    });
  }

  // 认证为唯一正式版本。并发安全：事务内检查，先到者成功，后来者收到 CONFLICT。
  async certifyVersion(input, actor) {
    this.#requireRole(actor, [ROLES.TECHNICAL_DELEGATE], "正式版本认证");
    return this.store.transact((state) => {
      const version = state.versions.get(input.versionId);
      if (!version) throw new DomainError("NOT_FOUND", "版本不存在", { status: 404 });
      if (state.certifiedVersions.has(input.versionId)) {
        throw new DomainError("ALREADY_OFFICIAL", `版本 ${input.versionId} 已是正式版本`, { status: 409 });
      }
      if (state.certifiedVersions.size > 0) {
        throw new DomainError(
          "OFFICIAL_VERSION_EXISTS",
          `正式版本已存在（${[...state.certifiedVersions].join(", ")}），一场成绩只能有一个正式版本`,
          { status: 409, officialVersionId: [...state.certifiedVersions][0] },
        );
      }
      const gates = evaluateGates(state, version, { nowUtc: this.#now(input.atUtc) });
      if (!gatesAllPassed(gates)) {
        throw new DomainError("GATES_NOT_PASSED", "存在未通过的认定门禁，不能认证正式版本", {
          status: 409,
          gates: gates.map((g) => ({ gate: g.gate, status: g.status })),
        });
      }
      return createEvent(
        EVENT_TYPES.VERSION_CERTIFIED,
        { versionId: input.versionId },
        { atUtc: this.#now(input.atUtc), actorId: actor.id, actorRole: actor.role, source: "td-office" },
      );
    });
  }

  // 纪录认定：仅技术代表；版本必须为唯一正式版本，声称环值须与版本计算一致，
  // 且超越旧纪录（若提供）。
  async ratifyRecord(input, actor) {
    this.#requireRole(actor, [ROLES.TECHNICAL_DELEGATE], "纪录认定");
    return this.store.transact((state) => {
      if (!state.certifiedVersions.has(input.versionId)) {
        throw new DomainError("VERSION_NOT_OFFICIAL", "只能对正式版本认定纪录", { status: 409 });
      }
      const version = state.versions.get(input.versionId);
      const result = version.results.get(input.athleteId);
      if (!result) throw new DomainError("NOT_FOUND", "版本中无该运动员成绩", { status: 404 });
      if (result.totalTenths !== input.claimedTotalTenths) {
        throw new DomainError(
          "TOTAL_MISMATCH",
          `声称 ${input.claimedTotalTenths} 与正式计算 ${result.totalTenths} 不一致`,
          { status: 409, computedTotalTenths: result.totalTenths },
        );
      }
      if (
        input.previousRecordTenths != null &&
        result.totalTenths <= input.previousRecordTenths
      ) {
        throw new DomainError("NOT_A_RECORD", "成绩未超越原纪录", { status: 409 });
      }
      const dup = state.ratifications.find(
        (r) => r.athleteId === input.athleteId && r.recordType === input.recordType,
      );
      if (dup) throw new DomainError("RECORD_EXISTS", "该运动员该类纪录已认定", { status: 409 });
      return createEvent(
        EVENT_TYPES.RECORD_RATIFIED,
        {
          versionId: input.versionId,
          athleteId: input.athleteId,
          recordType: input.recordType,
          certificateId: input.certificateId ?? null,
        },
        { atUtc: this.#now(input.atUtc), actorId: actor.id, actorRole: actor.role, source: "td-office" },
      );
    });
  }

  // ---- 读取 ----------------------------------------------------------------

  getState() {
    return this.store.replay();
  }
}
