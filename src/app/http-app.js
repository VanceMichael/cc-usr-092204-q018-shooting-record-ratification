import { CompetitionService } from "./service.js";
import { EventStore } from "../domain/store.js";
import { buildScoreboard, projectAthleteView } from "./view.js";
import { buildEvidencePackage } from "./evidence.js";
import { evaluateGates, gatesSummary } from "../domain/gates.js";
import { formatInstant } from "../domain/clock.js";
import { DomainError, ROLES } from "./roles.js";

// 单赛事内存应用装配；HTTP 为薄路由层，全部语义在领域/应用层。
// handle(request, extra) -> { status, body }，不接触 socket，便于测试。
export function buildApp(options = {}) {
  const service = options.service ?? new CompetitionService({ store: new EventStore(), clock: options.clock });
  const loadActor = options.loadActor ?? defaultLoadActor;
  const handle = (request, extra = {}) => dispatch(service, request, loadActor, extra);
  return { service, handle };
}

export function defaultLoadActor(token) {
  // 演示令牌：ROLE:id[:athleteId]，缺省为观众。
  if (!token) return { role: ROLES.SPECTATOR, id: "anonymous" };
  const [role, id, athleteId] = token.split(":");
  return { role, id: id ?? role.toLowerCase(), athleteId };
}

async function readBody(request) {
  if (request.headers["content-length"] === "0") return {};
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError("BAD_JSON", "请求体不是合法 JSON", { status: 400 });
  }
}

async function dispatch(service, request, loadActor, extra) {
  const url = new URL(request.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const actor = loadActor(request.headers["x-actor-token"]);
  const nowUtc = extra.nowUtc ?? new Date().toISOString();
  const state = () => service.getState();
  const officialOnly = () =>
    [ROLES.REFEREE, ROLES.JURY, ROLES.TECHNICAL_DELEGATE].includes(actor.role);

  // ---- 只读端点 ----
  const reads = [
    {
      method: "GET",
      pattern: ["health"],
      run: () => ({ status: 200, body: { status: "ok" } }),
    },
    {
      method: "GET",
      pattern: ["scoreboard"],
      run: () => ({ status: 200, body: buildScoreboard(state(), { nowUtc }) }),
    },
    {
      method: "GET",
      pattern: ["athletes", "*"],
      run: () => {
        const view = projectAthleteView(state(), parts[1], actor);
        if (!view) return { status: 404, body: { error: "运动员不存在" } };
        return { status: 200, body: { viewer: { role: actor.role }, athlete: view } };
      },
    },
    {
      method: "GET",
      pattern: ["versions", "*", "gates"],
      run: () => {
        if (!officialOnly()) return { status: 403, body: { error: "门禁明细仅官方角色可见" } };
        const s = state();
        const version = s.versions.get(parts[1]);
        if (!version) return { status: 404, body: { error: "版本不存在" } };
        const gates = evaluateGates(s, version, { nowUtc });
        return {
          status: 200,
          body: {
            versionId: parts[1],
            timezone: s.competition.timezone,
            deadline: version.protestDeadlineUtc
              ? {
                  utc: version.protestDeadlineUtc,
                  venueLocal: formatInstant(version.protestDeadlineUtc, s.competition.timezone),
                }
              : null,
            summary: gatesSummary(gates),
            gates,
          },
        };
      },
    },
    {
      method: "GET",
      pattern: ["evidence", "versions", "*"],
      run: () => {
        if (actor.role !== ROLES.TECHNICAL_DELEGATE) {
          return { status: 403, body: { error: "证据重放仅技术代表可用" } };
        }
        return {
          status: 200,
          body: buildEvidencePackage(service.store, {
            versionId: parts[2],
            athleteId: url.searchParams.get("athleteId"),
            nowUtc,
          }),
        };
      },
    },
    {
      method: "GET",
      pattern: ["events"],
      run: () => {
        if (!officialOnly()) return { status: 403, body: { error: "事件流仅官方角色可见" } };
        return { status: 200, body: service.store.records() };
      },
    },
  ];

  for (const endpoint of reads) {
    if (request.method === endpoint.method && matchParts(endpoint.pattern, parts)) {
      return endpoint.run();
    }
  }

  // ---- 写操作：POST /<action> ----
  if (request.method === "POST" && parts.length === 1) {
    const action = WRITE_ACTIONS[parts[0]];
    if (action) {
      const body = await readBody(request);
      const payload = { ...body, atUtc: body.atUtc ?? nowUtc };
      const result = await action(service, payload, actor);
      return { status: 200, body: result ?? { ok: true } };
    }
  }

  return { status: 404, body: { error: "未找到", method: request.method, path: url.pathname } };
}

function matchParts(pattern, parts) {
  return pattern.length === parts.length && pattern.every((p, i) => p === "*" || p === parts[i]);
}

const WRITE_ACTIONS = {
  competitions: (s, b, a) => s.openCompetition(b, a).then((id) => ({ competitionId: id })),
  athletes: (s, b, a) => s.registerAthlete(b, a),
  teams: (s, b, a) => s.registerTeam(b, a),
  devices: (s, b, a) => s.registerLaneDevice(b, a),
  "lane-assignments": (s, b, a) => s.assignLane(b, a),
  "calibration-checks": (s, b, a) => s.calibrationCheck(b, a),
  "time-sync-checks": (s, b, a) => s.timeSyncCheck(b, a),
  "start-confirmations": (s, b, a) => s.startConfirmed(b, a),
  "equipment-checks": (s, b, a) => s.equipmentCheck(b, a),
  shots: (s, b, a) => s.recordShot(b, a),
  signatures: (s, b, a) => s.signShots(b, a),
  voids: (s, b, a) => s.voidShot(b, a),
  reshots: (s, b, a) => s.awardReshot(b, a),
  penalties: (s, b, a) => s.addPenalty(b, a),
  withdrawals: (s, b, a) => s.withdrawAthlete(b, a),
  "display-snapshots": (s, b, a) => s.freezeDisplay(b, a),
  flashes: (s, b, a) => s.publishFlash(b, a).then((id) => ({ flashId: id })),
  protests: (s, b, a) => s.fileProtest(b, a).then((id) => ({ protestId: id })),
  "protest-resolutions": (s, b, a) => s.resolveProtest(b, a),
  versions: (s, b, a) => s.publishVersion(b, a).then((id) => ({ versionId: id })),
  "gate-evidence": (s, b, a) => s.submitGateEvidence(b, a),
  certifications: (s, b, a) => s.certifyVersion(b, a),
  ratifications: (s, b, a) => s.ratifyRecord(b, a),
};

export { DomainError };
