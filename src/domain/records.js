import { randomUUID } from "node:crypto";
import { badRequest, conflict, notFound } from "./errors.js";

/**
 * 纪录认定链：现场显示刷新纪录只是候选，必须集齐六项确认
 * （身份、靶位设备、每发数据、时间同步、器材检查、申诉窗口）
 * 才形成正式认定。媒体快讯不产生任何认定效力。
 */
export const RATIFICATION_STEPS = [
  "identity",
  "target_equipment",
  "shot_data",
  "time_sync",
  "equipment_control",
  "appeal_window",
];

export class RecordLedger {
  constructor() {
    this.candidates = new Map(); // candidateId -> candidate
  }

  keyOf(discipline, category, level) {
    return `${discipline}|${category}|${level}`;
  }

  get(candidateId) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw notFound(`纪录候选不存在: ${candidateId}`);
    return candidate;
  }

  currentMark(key) {
    let best = null;
    for (const candidate of this.candidates.values()) {
      if (candidate.key === key && candidate.status === "ratified") {
        if (!best || candidate.total > best.total) best = candidate;
      }
    }
    return best;
  }

  /** 正式确认的总环值超过现行纪录时登记候选；否则返回 null。 */
  consider({
    discipline,
    category,
    level,
    athleteId,
    matchId,
    total,
    scorecardVersion,
    officialAtUtc,
    appealDeadlineUtc,
  }) {
    const key = this.keyOf(discipline, category, level);
    const current = this.currentMark(key);
    if (current && total <= current.total) return null;
    for (const candidate of this.candidates.values()) {
      if (candidate.key === key && candidate.status === "pending" && candidate.total >= total) {
        return null;
      }
    }
    const candidate = {
      id: randomUUID(),
      key,
      discipline,
      category,
      level,
      athleteId,
      matchId,
      total,
      scorecardVersion,
      officialAtUtc,
      appealDeadlineUtc,
      status: "pending", // pending | ratified | superseded
      approvals: {},
      createdAtUtc: officialAtUtc,
      ratifiedAtUtc: null,
    };
    this.candidates.set(candidate.id, candidate);
    return candidate;
  }

  /** 登记一项确认；六项齐全即转正，并淘汰同项更低的待定候选。 */
  approve(candidateId, step, actor, atUtc) {
    const candidate = this.get(candidateId);
    if (!RATIFICATION_STEPS.includes(step)) {
      throw badRequest(`未知认定环节: ${step}`);
    }
    if (candidate.status !== "pending") {
      throw conflict(`纪录候选已不在待认定状态: ${candidate.status}`);
    }
    candidate.approvals[step] = {
      actorId: actor.id,
      signature: actor.signature ?? null,
      atUtc,
    };
    if (RATIFICATION_STEPS.every((name) => candidate.approvals[name])) {
      candidate.status = "ratified";
      candidate.ratifiedAtUtc = atUtc;
      for (const other of this.candidates.values()) {
        if (
          other.id !== candidate.id &&
          other.key === candidate.key &&
          other.status === "pending" &&
          other.total <= candidate.total
        ) {
          other.status = "superseded";
        }
      }
    }
    return candidate;
  }

  list() {
    return [...this.candidates.values()];
  }
}
