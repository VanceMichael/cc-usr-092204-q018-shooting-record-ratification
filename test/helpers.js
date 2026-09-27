import { CompetitionService } from "../src/app/service.js";
import { EventStore } from "../src/domain/store.js";
import { createEvent, EVENT_TYPES } from "../src/domain/events.js";

export const REFEREE = { id: "R-T", role: "REFEREE" };
export const JURY = { id: "J-T", role: "JURY" };
export const TD = { id: "TD-T", role: "TECHNICAL_DELEGATE" };

// 直接向事件存储折叠原始事件（纯领域层，绕过应用服务的角色检查）。
export function seedStore(events) {
  const store = new EventStore();
  return store.appendAll(events).then(() => store);
}

export function ev(type, payload, atUtc = "2024-01-01T00:00:00Z", actor = REFEREE) {
  return createEvent(type, payload, {
    atUtc,
    actorId: actor.id,
    actorRole: actor.role,
    source: "test",
  });
}

// 通过应用服务搭一个"门禁齐备"的最小 60 发赛事（一人一枪位）。
export async function buildReadyCompetition(options = {}) {
  const service = new CompetitionService();
  const R = REFEREE;
  const t0 = "2024-05-01T01:00:00Z";
  await service.openCompetition(
    {
      competitionId: "CMP-T",
      name: "测试赛",
      discipline: "AR60W",
      ruleVersion: "ISSF-RIFLE-2022",
      startedAtUtc: t0,
      timezone: "Asia/Shanghai",
      atUtc: t0,
    },
    R,
  );
  await service.registerAthlete({ athleteId: "A1", displayName: "甲", bib: "1", atUtc: t0 }, R);
  await service.registerLaneDevice({ laneId: "L1", deviceId: "ET1", serial: "SN1", atUtc: t0 }, R);
  await service.assignLane({ athleteId: "A1", laneId: "L1", atUtc: t0 }, R);
  await service.calibrationCheck({ laneId: "L1", verdict: "PASS", atUtc: t0 }, R);
  await service.timeSyncCheck({ verdict: "PASS", driftMillis: 5, atUtc: t0 }, R);
  await service.equipmentCheck({ athleteId: "A1", verdict: "PASS", findings: "ok", atUtc: t0 }, R);

  const shotIds = [];
  for (let s = 1; s <= 6; s += 1) {
    for (let p = 1; p <= 10; p += 1) {
      const id = `A1-S${s}P${p}`;
      shotIds.push(id);
      await service.recordShot(
        {
          athleteId: "A1",
          shotId: id,
          series: s,
          position: p,
          tenths: options.shotTenths ?? 105,
          laneId: "L1",
          atUtc: new Date(Date.parse(t0) + (s * 10 + p) * 1000).toISOString(),
        },
        R,
      );
    }
  }
  await service.signShots({ athleteId: "A1", shotIds, atUtc: "2024-05-01T02:00:00Z" }, R);

  const publishedAt = options.publishedAt ?? "2024-05-01T02:00:30Z";
  const deadline = new Date(Date.parse(publishedAt) + 10 * 60000).toISOString();
  await service.publishVersion({ versionId: "V1", label: "初版", atUtc: publishedAt }, R);
  for (const gate of ["IDENTITY", "DEVICE", "SHOT_DATA", "TIME_SYNC", "EQUIPMENT"]) {
    await service.submitGateEvidence(
      { versionId: "V1", gate, verdict: "PASS", atUtc: new Date(Date.parse(publishedAt) + 30000).toISOString() },
      R,
    );
  }
  await service.submitGateEvidence(
    { versionId: "V1", gate: "PROTEST_WINDOW", verdict: "PASS", atUtc: new Date(Date.parse(deadline) + 30000).toISOString() },
    JURY,
  );
  return { service, deadline, publishedAt, shotIds };
}

// HTTP 测试用的内存请求对象。
export function mockRequest(method, url, { token, body } = {}) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return {
    method,
    url,
    headers: {
      "x-actor-token": token,
      "content-length": body ? String(Buffer.byteLength(JSON.stringify(body))) : "0",
    },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          if (i >= chunks.length) return Promise.resolve({ value: undefined, done: true });
          return Promise.resolve({ value: chunks[i++], done: false });
        },
      };
    },
  };
}
