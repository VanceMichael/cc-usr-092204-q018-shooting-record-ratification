import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ShootingService } from "../src/service.js";
import { createHandler } from "../src/api.js";

async function boot() {
  const service = new ShootingService({ clock: () => "2026-09-26T08:00:00.000Z" });
  const server = createServer(createHandler(service));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    service,
    close: () => new Promise((resolve) => server.close(resolve)),
    async call(method, path, { body, role } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(role ? { "x-role": role } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, json: await response.json() };
    },
  };
}

test("HTTP API：报名、发弹、复核确认与并发冲突", async () => {
  const api = await boot();
  try {
    await api.call("POST", "/matches", {
      body: {
        matchId: "m1",
        rulesetId: "issf-ar60-2024",
        discipline: "10m-air-rifle",
        category: "women",
        recordLevels: ["ASIAN"],
      },
    });
    await api.call("POST", "/matches/m1/athletes", {
      body: { athleteId: "A1", displayName: "选手-A1", personal: { idNumber: "X" } },
    });
    for (let i = 0; i < 10; i += 1) {
      const res = await api.call("POST", "/matches/m1/shots", {
        body: {
          athleteId: "A1",
          targetId: "T1",
          series: 1,
          shot: i + 1,
          value: 10.6,
          firedAtUtc: "2026-09-26T09:00:00.000Z",
          device: { id: "DEV-1", clockOffsetMs: 2 },
        },
      });
      assert.equal(res.status, 201);
    }

    // 观众视图：临时状态、无隐私字段
    const audience = await api.call("GET", "/matches/m1/scorecards/A1");
    assert.equal(audience.json.status, "provisional");
    assert.equal(audience.json.total, 106.0);
    assert.equal(audience.json.athlete.personal, undefined);

    // 技术代表视图：设备细节可见
    const td = await api.call("GET", "/matches/m1/scorecards/A1", { role: "technical_delegate" });
    assert.equal(td.json.shots[0].deviceId, "DEV-1");

    // 复核 → 确认；并发第二次确认 → 409
    await api.call("POST", "/matches/m1/scorecards/A1/review", {
      body: { expectedVersion: 10, officialId: "r1", signature: "s1" },
    });
    const ok = await api.call("POST", "/matches/m1/scorecards/A1/confirm", {
      body: { expectedVersion: 10, officialId: "r1", signature: "s1" },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, "official");
    const dup = await api.call("POST", "/matches/m1/scorecards/A1/confirm", {
      body: { expectedVersion: 10, officialId: "r2", signature: "s2" },
    });
    assert.equal(dup.status, 409);

    // 纪录候选产生，观众不可见，技术代表可重放
    const publicRecords = await api.call("GET", "/records");
    assert.equal(publicRecords.json.length, 0);
    const records = await api.call("GET", "/records", { role: "technical_delegate" });
    assert.equal(records.json.length, 1);
    const replay = await api.call("GET", `/records/${records.json[0].id}/replay`, {
      role: "technical_delegate",
    });
    assert.equal(replay.json.recomputation.consistent, true);
    const forbidden = await api.call("GET", `/records/${records.json[0].id}/replay`);
    assert.equal(forbidden.status, 403);

    // 时间线带时区
    const timeline = await api.call("GET", "/matches/m1/timeline?zone=Asia/Shanghai");
    assert.equal(timeline.json[0].statusLabel, "正式");
    assert.equal(timeline.json[0].zone, "Asia/Shanghai");

    // 健康检查与领域资料入口保持可用
    const health = await api.call("GET", "/health");
    assert.equal(health.json.status, "ok");
    const context = await api.call("GET", "/context");
    assert.equal(context.json.project, "射击纪录认定链");
  } finally {
    await api.close();
  }
});
