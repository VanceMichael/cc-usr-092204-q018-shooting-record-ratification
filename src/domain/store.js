import { hashEvent } from "./hashing.js";
import { foldEvents, emptyState } from "./aggregate.js";

// 追加事件日志。每条记录带链哈希：H(prevHash || canonical(event))。
// 单进程内以串行队列保证并发裁判提交的原子性；重放可发现任何篡改。
export class EventStore {
  #records = [];
  #chain = []; // 与 records 对齐的哈希
  #queue = Promise.resolve();

  static get GENESIS_HASH() {
    return "0".repeat(64);
  }

  get length() {
    return this.#records.length;
  }

  // 串行化追加：并发复核在此排队，每条事件落库前用最新链头计算哈希。
  append(event) {
    const run = this.#queue.then(() => {
      const prevHash = this.#chain.at(-1) ?? EventStore.GENESIS_HASH;
      const hash = hashEvent(prevHash, event);
      const record = { seq: this.#records.length + 1, hash, prevHash, event };
      this.#records.push(record);
      this.#chain.push(hash);
      return record;
    });
    // 维持队列链，吞掉已向外抛出的错误，避免链条断裂
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async appendAll(events) {
    const out = [];
    for (const event of events) out.push(await this.append(event));
    return out;
  }

  // 事务：在队列锁内重放当前状态，交由 fn 判定并返回要追加的事件。
  // 并发裁判的复核由此串行——后来者看到的是包含前者结果的新状态。
  transact(fn) {
    const run = this.#queue.then(async () => {
      const state = this.replay();
      const produced = await fn(state);
      const events = Array.isArray(produced) ? produced : [produced];
      const appended = [];
      for (const event of events) {
        const prevHash = this.#chain.at(-1) ?? EventStore.GENESIS_HASH;
        const hash = hashEvent(prevHash, event);
        const record = { seq: this.#records.length + 1, hash, prevHash, event };
        this.#records.push(record);
        this.#chain.push(hash);
        appended.push(record);
      }
      return Array.isArray(produced) ? appended : appended[0];
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  records() {
    return this.#records.map((r) => structuredClone(r));
  }

  events() {
    return this.#records.map((r) => structuredClone(r.event));
  }

  headHash() {
    return this.#chain.at(-1) ?? EventStore.GENESIS_HASH;
  }

  // 从持久化介质逐记录恢复：保留原有哈希（不信任重算），
  // 之后 verifyChain() 可发现磁盘/传输环节的任何篡改。
  loadPersisted(records) {
    for (const record of records) {
      this.#records.push(structuredClone(record));
      this.#chain.push(record.hash);
    }
  }

  // 校验链完整性：重算全部哈希，任一不匹配即说明日志被改动。
  verifyChain() {
    let prev = EventStore.GENESIS_HASH;
    for (let i = 0; i < this.#records.length; i += 1) {
      const record = this.#records[i];
      const expected = hashEvent(prev, record.event);
      if (record.prevHash !== prev || record.hash !== expected) {
        return { ok: false, brokenAt: record.seq, expected, actual: record.hash };
      }
      prev = record.hash;
    }
    return { ok: true, head: prev, count: this.#records.length };
  }

  // 重放到当前（或指定 seq 前缀），得到归约状态。
  replay(upToSeq = null) {
    const state = emptyState();
    const slice = upToSeq == null ? this.#records : this.#records.slice(0, upToSeq);
    for (const record of slice) foldEvents([record.event], state);
    return state;
  }
}
