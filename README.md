# 射击纪录认定链

本项目服务于管理射击资格赛原始成绩、裁判修正与纪录认定。仓库保存领域资料、交换契约和可运行的服务入口，便于参与方在同一语义下协作。

## 领域事实

- 女子十米气步枪资格赛产生新的亚洲纪录
- 报道给出正式总环值
- 纪录发生在亚运会资格赛阶段

## 设计要点

- **事件溯源**：电子靶原始流、裁判修正、复核确认全部只追加（`src/domain/store.js`），任何更改不改写历史；成绩以版本累计，首次打满 60 发的对外显示结果永久保留（`displayedOriginally`）。
- **竞赛版本固定**：比赛报名时锁定计环版本（`src/domain/rulesets.js`），分项/总环计算与申诉窗口（2022 版 20 分钟、2024 版 30 分钟）按该版本执行。
- **追加式修正**：校准异常、作废、补射、弃权、判罚都是新事件；已正式确认的成绩只能凭已成立的申诉修正，修正后退回临时状态须重新复核。
- **并发复核单版本**：复核与确认都携带期望版本号，同一版本只允许一次确认成功，后到者收到 409 冲突。
- **独立排名**：团体与个人引用同一发弹数据，排名序列各自独立。
- **角色化视图**：观众（环值与状态）、裁判（每发数据与器材概要）、技术代表（设备时钟、校准报告、签名与认定证据）。
- **纪录认定链**：正式总环值超过现行纪录才登记候选；身份、靶位设备、每发数据、时间同步、器材检查、申诉窗口六项确认齐全才转正，媒体快讯不产生认定效力。技术代表可从一项纪录重放全部计算、校准与批准证据。
- **跨时区**：全部时刻以 UTC 存储，发布与申诉截止按 IANA 时区本地化显示。

## 成绩状态

| 状态 | 含义 |
| --- | --- |
| `provisional`（临时） | 发弹与修正仍在追加 |
| `pending_confirmation`（待确认） | 裁判已提交复核，等待确认 |
| `official`（正式） | 已确认的唯一正式版本 |

## 目录说明

- `contracts/` 保存交换数据的结构约定（领域上下文、成绩事件信封）。
- `fixtures/` 提供去标识的领域样例。
- `src/domain/` 领域核心：规则版本、事件存储、投影计环、纪录认定链、角色化视图、时区。
- `src/service.js` 命令编排与并发控制；`src/api.js` HTTP 路由；`src/server.js` 服务入口。
- `test/` 核对计环、修正、并发、排名、申诉、认定、重放、隐私与时区行为。

## HTTP 接口

- `POST /matches` 登记比赛（锁定竞赛版本、纪录级别、场馆时区）
- `POST /matches/:id/athletes` 运动员报名
- `POST /matches/:id/shots` 接收电子靶原始发弹（设备标识、时钟偏移、击发时刻）
- `POST /matches/:id/corrections` 追加修正（`calibration_anomaly` / `shot_void` / `reshoot` / `penalty` / `withdrawal`）
- `POST /matches/:id/scorecards/:athleteId/review` 提交复核（携带 `expectedVersion`）
- `POST /matches/:id/scorecards/:athleteId/confirm` 确认正式版本（版本互斥）
- `POST /matches/:id/appeals` / `POST /matches/:id/appeals/:appealId/resolve` 申诉与结案
- `GET /matches/:id/scorecards[/:athleteId]` 成绩视图（`x-role` 控制开放范围）
- `GET /matches/:id/rankings/individual|team` 个人 / 团体排名
- `GET /matches/:id/timeline?zone=Asia/Shanghai` 观众时间线（本地化发布与截止时间）
- `GET /records` 纪录台账（观众仅见已认定）
- `POST /records/:id/approvals` 确认认定环节（仅技术代表）
- `GET /records/:id/replay` 重放认定证据（仅技术代表）

## 本地检查

运行 `npm test` 可以检查当前资料与服务入口；`npm start` 在 `127.0.0.1:8000` 启动服务。
