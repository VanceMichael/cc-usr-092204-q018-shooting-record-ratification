import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app/http-app.js";
import { bootstrapService } from "../src/app/bootstrap.js";
import { buildReadyCompetition, mockRequest, REFEREE, TD } from "./helpers.js";
import { ROLES } from "../src/app/roles.js";
import { buildScoreboard, STATUS } from "../src/app/view.js";
import { EVENT_TYPES } from "../src/domain/events.js";

async function scenarioApp() {
  const service = await bootstrapService();
  return { app: buildApp({ service }), service };
}

test("HTTP：观众可读记分板；证据与事件流按角色 403/200", async () => {
  const { app } = await scenarioApp();

  const health = await app.handle(mockRequest("GET", "/health"));
  assert.equal(health.status, 200);

  const board = await app.handle(mockRequest("GET", "/scoreboard"));
  assert.equal(board.status, 200);
  assert.equal(board.body.board.status, "OFFICIAL");

  const denied = await app.handle(mockRequest("GET", "/evidence/versions/V-Q-001"));
  assert.equal(denied.status, 403);

  const eventsDenied = await app.handle(mockRequest("GET", "/events"));
  assert.equal(eventsDenied.status, 403);

  const evidence = await app.handle(
    mockRequest("GET", "/evidence/versions/V-Q-001?athleteId=A-CHN-101", { token: "TECHNICAL_DELEGATE:TD-001" }),
  );
  assert.equal(evidence.status, 200);
  assert.equal(evidence.body.chain.intact, true);

  const eventsOk = await app.handle(mockRequest("GET", "/events", { token: "REFEREE:R-001" }));
  assert.equal(eventsOk.status, 200);
  assert.ok(eventsOk.body.length > 400);
});

test("HTTP：门禁明细仅官方；运动员本人弹级数据可用本人令牌访问", async () => {
  const { app } = await scenarioApp();
  const gatesDenied = await app.handle(mockRequest("GET", "/versions/V-Q-001/gates"));
  assert.equal(gatesDenied.status, 403);
  const gates = await app.handle(mockRequest("GET", "/versions/V-Q-001/gates", { token: "REFEREE:R-001" }));
  assert.equal(gates.status, 200);
  assert.equal(gates.body.deadline.venueLocal, "2023-09-24T10:10:30+08:00");

  const self = await app.handle(
    mockRequest("GET", "/athletes/A-CHN-101", { token: "ATHLETE:p1:A-CHN-101" }),
  );
  assert.equal(self.status, 200);
  assert.equal(self.body.athlete.shots.length, 61);

  const other = await app.handle(mockRequest("GET", "/athletes/A-CHN-101", { token: "ATHLETE:p2:A-KOR-201" }));
  assert.equal(other.status, 200);
  assert.equal(other.body.athlete.shots, undefined);
});

test("HTTP：写操作经服务层角色检查，观众上送弹着被拒（403 语义）", async () => {
  const { app } = await scenarioApp();
  await assert.rejects(
    () =>
      app.handle(
        mockRequest("POST", "/shots", {
          token: "SPECTATOR:x",
          body: { athleteId: "A-CHN-101", shotId: "z", series: 1, position: 1, tenths: 100 },
        }),
      ),
    (e) => e.status === 403,
  );
});

test("HTTP：正式版本后裁判再发版本被拒（409 OFFICIAL_LOCKED）", async () => {
  const { app } = await scenarioApp();
  await assert.rejects(
    () =>
      app.handle(
        mockRequest("POST", "/versions", {
          token: "REFEREE:R-001",
          body: { versionId: "V-Q-002", label: "二版" },
        }),
      ),
    (e) => e.status === 409 && e.code === "OFFICIAL_LOCKED",
  );
});

test("生命周期：临时（635.4 大屏）→ 待确认（窗口/申诉未完）→ 正式（636.8）", async () => {
  const { service } = await scenarioApp();
  const records = service.store.records();
  const seqOf = (type, predicate = () => true, from = 0) =>
    records.findIndex((r, i) => i >= from && r.event.type === type && predicate(r.event)) + 1;

  // 1) 第一次大屏冻结（635.4）之后、修正之前：临时盘
  const firstFreeze = seqOf(EVENT_TYPES.DISPLAY_SNAPSHOT_FROZEN);
  const provisionalState = service.store.replay(firstFreeze);
  const provisional = buildScoreboard(provisionalState, { nowUtc: "2023-09-24T01:55:00Z" });
  assert.equal(provisional.board.status, STATUS.PROVISIONAL);
  assert.equal(provisional.board.individuals[0].total, "635.4");

  // 2) 版本刚发布、窗口未关闭：待确认，申诉窗口门禁 WAIT
  const publishedSeq = seqOf(EVENT_TYPES.VERSION_PUBLISHED);
  const pendingState = service.store.replay(publishedSeq);
  const pending = buildScoreboard(pendingState, { nowUtc: "2023-09-24T02:01:00Z" });
  assert.equal(pending.board.status, STATUS.PENDING_CONFIRMATION);
  assert.deepEqual(pending.board.gates.passed, []);
  assert.ok(pending.board.gates.waiting.includes("PROTEST_WINDOW"));

  // 3) 全部事件之后：正式
  const official = buildScoreboard(service.store.replay(), { nowUtc: "2023-09-24T02:20:00Z" });
  assert.equal(official.board.status, STATUS.OFFICIAL);
  assert.equal(official.board.individuals[0].total, "636.8");
});

test("生命周期：窗口关闭但申诉未裁决时，申诉窗口门禁 FAIL，不能认证", async () => {
  const { service } = await scenarioApp();
  const records = service.store.records();
  // 截至 PROTEST_FILED 之后（尚无 RESOLVED），且时间越过截止
  const filedSeq = records.findIndex((r) => r.event.type === EVENT_TYPES.PROTEST_FILED) + 1;
  const state = service.store.replay(filedSeq);
  const version = state.versions.get("V-Q-001");
  const { evaluateGates } = await import("../src/domain/gates.js");
  const gates = evaluateGates(state, version, { nowUtc: "2023-09-24T02:15:00Z" });
  const protestGate = gates.find((g) => g.gate === "PROTEST_WINDOW");
  assert.equal(protestGate.status, "FAIL");
  assert.deepEqual(protestGate.detail.openProtests, ["PRT-001"]);
});
