// 角色。字段级开放按角色在视图层执行（view.js），此处负责动作级权限。
export const ROLES = Object.freeze({
  SPECTATOR: "SPECTATOR", // 观众：仅看临时/待确认/正式状态
  MEDIA: "MEDIA", // 媒体：快讯登记、读状态
  ATHLETE: "ATHLETE", // 运动员：本人相关、申诉
  REFEREE: "REFEREE", // 裁判：原始流确认、修正、签名、前五道门禁
  JURY: "JURY", // 仲裁：申诉裁决、申诉窗口门禁
  TECHNICAL_DELEGATE: "TECHNICAL_DELEGATE", // 技术代表：唯一正式版本认证、纪录认定、全证据重放
});

export class DomainError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    Object.assign(this, extra);
  }
}
