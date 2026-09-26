/**
 * 追加式事件存储：原始发弹、裁判修正、复核确认一律只追加，
 * 任何更改都不改写历史事件，原始显示结果由此得到保留。
 */
export class EventStore {
  #events = [];
  #seq = 0;

  append(event) {
    const stored = { ...event, seq: ++this.#seq };
    this.#events.push(stored);
    return stored;
  }

  ofMatch(matchId) {
    return this.#events.filter((event) => event.matchId === matchId);
  }

  all() {
    return [...this.#events];
  }
}
