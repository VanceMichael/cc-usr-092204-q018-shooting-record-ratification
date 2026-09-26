import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validate } from "../src/contracts.js";
import { OFFICIAL, makeHarness, setupMatch } from "./helpers.js";

const schema = JSON.parse(
  await readFile(new URL("../contracts/score-event.schema.json", import.meta.url), "utf8"),
);

test("认定链上的事件全部符合交换契约", async () => {
  const { service } = makeHarness();
  setupMatch(service);
  service.correct("match-1", {
    type: "penalty",
    athleteId: "A2",
    rings: 2,
    reason: "装备检查不合格",
    ...OFFICIAL,
  });
  service.reviewScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });
  service.confirmScorecard("match-1", "A1", { expectedVersion: 60, ...OFFICIAL });

  const events = service.store.all();
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.deepEqual(validate(schema, event), [], `事件 ${event.type} 不符合契约`);
  }
});

test("契约校验器能发现结构缺陷", () => {
  const errors = validate(schema, { id: "e1", type: "unknown_type" });
  assert.ok(errors.some((error) => error.includes("matchId")));
  assert.ok(errors.some((error) => error.includes("unknown_type")));
});
