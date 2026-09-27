import { createHash } from "node:crypto";

// 事件链哈希：SHA-256，十六进制。任何事件被增删改都会让其后所有哈希失配，
// 技术代表重放证据包时据此发现篡改。
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonical(value) {
  return JSON.stringify(value, (key, val) => {
    if (val instanceof Map) return Object.fromEntries(val);
    if (val === undefined) return null;
    return val;
  });
}

export function hashEvent(prevHash, event) {
  return sha256(`${prevHash}\n${canonical(event)}`);
}
