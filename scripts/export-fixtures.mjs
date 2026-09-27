// 导出去标识演示场景的事件链（含哈希）为 JSONL，兼作持久化日志格式样例，
// 并单独导出电子靶原始流（仅 SHOT_RECORDED）。
// 运行：node scripts/export-fixtures.mjs
import { writeFile, mkdir } from "node:fs/promises";
import { bootstrapService } from "../src/app/bootstrap.js";

const service = await bootstrapService();
const records = service.store.records();

await mkdir(new URL("../fixtures/", import.meta.url), { recursive: true });

await writeFile(
  new URL("../fixtures/scenario-event-log.jsonl", import.meta.url),
  `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
);

const rawFeed = records
  .filter((r) => r.event.source === "electronic-target" || r.event.source === "electronic-target-reshot")
  .map((r) =>
    JSON.stringify({
      shotId: r.event.shotId,
      athleteId: r.event.athleteId,
      series: r.event.series,
      position: r.event.position,
      tenths: r.event.tenths,
      laneId: r.event.laneId,
      deviceId: r.event.deviceId,
      atUtc: r.event.atUtc,
    }),
  )
  .join("\n");
await writeFile(new URL("../fixtures/electronic-target-stream.jsonl", import.meta.url), `${rawFeed}\n`);

console.log(`导出 ${records.length} 条事件链记录、${rawFeed.split("\n").length} 条电子靶原始读数`);
