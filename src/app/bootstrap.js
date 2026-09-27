import { CompetitionService } from "./service.js";
import { EventStore } from "../domain/store.js";
import { buildScenarioEvents } from "../scenario/women10mAR.js";

// 以事件溯源方式装配：演示场景的全部事件按序追加到空日志。
// 真实部署中这里改为从持久化日志加载。
export async function bootstrapService(options = {}) {
  const store = options.store ?? new EventStore();
  const service = new CompetitionService({ store, clock: options.clock });
  if (store.length === 0) {
    await store.appendAll(buildScenarioEvents());
  }
  return service;
}
