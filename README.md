# 射击成绩与纪录认定后台

接收电子靶原始流与裁判签名，按竞赛版本计算分项与总环值；设备校准异常、补射、
弃权、判罚全部以**追加事件**修正，任何更改都保留原始弹着与现场显示结果。
成绩版本经历 **临时 → 待确认 → 正式** 三态，裁判并发复核只能形成一个正式版本；
技术代表可从一项纪录重放全部计算、校准与批准证据。

## 领域主线（去标识演示场景）

2023 杭州亚运·女子 10 米气步枪资格赛（60 发，赛区 `Asia/Shanghai`）：

1. 60 发结束，现场大屏冻结 **635.4 环**（第 3 系列第 7 发为设备异常读数 9.1）。
2. 赛后靶位校准复查 FAIL（漂移 −1.4 环）→ 原 9.1 弹**作废但保留** → 追加补射 10.5。
3. 大屏二次冻结 **636.8 环**；媒体发出"636.8 环刷新亚洲纪录"快讯。
4. 裁判发布成绩版本（申诉窗口 10 分钟，本地 10:00:30→10:10:30）。
5. 窗口内有申诉，仲裁驳回；六道门禁证据逐一签署。
6. 窗口关闭后技术代表认证 **唯一正式版本 V-Q-001**，随后认定亚洲纪录
   （证书 AR-2023-0042，原纪录 635.3）。

媒体快讯在系统中只是一条 `MEDIA_FLASH_PUBLISHED` 记录，永远带
"媒体快讯不构成正式认定"提示，不产生成绩版本。

## 核心设计

- **事件溯源 + 哈希链**（`src/domain/`）：所有事实都是不可变追加事件，
  `hash = SHA256(prevHash || canonical(event))`。`EventStore.verifyChain()`
  可发现任何历史篡改；`replay(seq)` 可重放到任意时刻。
- **按竞赛版本计算**（`rules.js` / `aggregate.js`）：`ISSF-RIFLE-2022`
  定义 6 系列 ×10 发、十分位计分（整数 `tenths` 运算，10.9 = 109）。
  归约器输出系列分项、总环、扣环、内十环、异常码；排名平局依次按
  内十环数 → 末系列起倒序 → 末发起倒序破除。团体与个人引用同一批弹着，
  各自独立排名；弃权者排除出两类排名但弹数据保留。
- **追加修正**：`SHOT_VOIDED` + `RESHOT_AWARDED`（补射替换计分位置）、
  `PENALTY_DEDUCTED`（可挂到系列）、`ATHLETE_WITHDRAWN`。原始
  `SHOT_RECORDED` 与 `DISPLAY_SNAPSHOT_FROZEN` 永不被覆盖。
- **三态与门禁**（`gates.js` / `view.js`）：
  - `PROVISIONAL` 临时：电子靶实时累计，无版本；
  - `PENDING_CONFIRMATION` 待确认：已发版，门禁/申诉窗口未完；
  - `OFFICIAL` 正式：技术代表认证；旧版本为 `SUPERSEDED`。
  六道门禁（身份、靶位设备、每发数据+签名、时间同步、器材、申诉窗口）
  每道都要求客观数据通过 **且** 责任人签署。
- **并发唯一正式版本**（`store.transact` CAS）：认证在事件日志锁内
  "先检查后落事件"，并发复核只有一个成功，第二个收到 `ALREADY_OFFICIAL`；
  正式版本锁定后再发新版本返回 `OFFICIAL_LOCKED`。
- **跨时区**（`clock.js`）：内部只存 UTC，展示层按赛区 IANA 时区换算
  （含偏移），申诉截止以赛区本地钟点表达。
- **角色化开放**（`roles.js` / `view.js`）：
  观众/媒体只见公开成绩与状态；运动员只见本人弹级数据、器材结论（细节屏蔽）；
  裁判/仲裁/技术代表可见设备序列号、校准漂移、器材检查细节与作废原因；
  证据重放仅技术代表可用。
- **证据重放**（`evidence.js`）：技术代表证据包独立重算并与封存版本逐发对账，
  汇总校准时间线、六道门禁、申诉、认证、认定、两次大屏与链完整性。

## 目录

- `src/domain/` 规则、时钟、事件、归约、哈希链存储、门禁
- `src/app/` 应用服务（权限/状态机）、视图脱敏、证据包、HTTP 装配、场景引导
- `src/scenario/women10mAR.js` 636.8 环演示场景（420 个事件）
- `contracts/` 事件链记录、成绩状态、领域上下文 JSON Schema
- `fixtures/` 领域上下文、事件链 JSONL、电子靶原始流 JSONL
- `scripts/export-fixtures.mjs` 重新导出 JSONL

## HTTP 接口

启动：`npm start`（默认 `127.0.0.1:8000`），角色经
`x-actor-token: ROLE:id[:athleteId]` 头传递，缺省为观众。

| 方法/路径 | 角色 | 说明 |
| --- | --- | --- |
| `GET /scoreboard` | 公开 | 三态记分板、个人/团体排名、版本列表、快讯对照 |
| `GET /athletes/:id` | 公开/本人/官方 | 字段按角色脱敏 |
| `GET /versions/:id/gates` | 裁判/仲裁/技术代表 | 六道门禁明细与赛区本地截止时刻 |
| `GET /evidence/versions/:id?athleteId=` | 技术代表 | 全证据重放包 |
| `GET /events` | 官方 | 哈希链全部记录 |
| `POST /shots` `/signatures` `/voids` `/reshots` `/penalties` `/withdrawals` | 裁判 | 原始流与追加修正 |
| `POST /calibration-checks` `/time-sync-checks` `/equipment-checks` | 裁判 | 赛前/赛后检查 |
| `POST /display-snapshots` `/flashes` | 裁判 / 媒体 | 大屏冻结、快讯登记 |
| `POST /protests` `/protest-resolutions` | 运动员本人/仲裁 | 窗口校验、裁决 |
| `POST /versions` `/gate-evidence` | 裁判（窗口门为仲裁） | 发版、门禁签署 |
| `POST /certifications` `/ratifications` | 技术代表 | 唯一正式版本、纪录认定 |

错误返回 `{ error, code, gates? }`，冲突语义用 409
（`GATES_NOT_PASSED` / `ALREADY_OFFICIAL` / `OFFICIAL_LOCKED` /
`PROTEST_WINDOW_CLOSED` / `TOTAL_MISMATCH` / `NOT_A_RECORD`）。

## 本地检查

```bash
npm test      # 31 个测试：计算、修正、排名、门禁、并发、窗口、RBAC、重放、HTTP
npm start     # 载入演示场景后提供接口
node scripts/export-fixtures.mjs
```

示例：

```bash
curl -s http://127.0.0.1:8000/scoreboard | head
curl -s -H 'x-actor-token: TECHNICAL_DELEGATE:TD-001' \
  'http://127.0.0.1:8000/evidence/versions/V-Q-001?athleteId=A-CHN-101'
```
