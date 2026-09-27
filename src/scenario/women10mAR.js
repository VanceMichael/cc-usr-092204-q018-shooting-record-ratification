// 2023 杭州亚运·女子 10 米气步枪资格赛（去标识演示场景）。
// 主线：60 发结束大屏先显示 635.4（含一发设备异常 9.1）；赛后校准发现漂移，
// 作废该发并追加补射 10.5，成绩修正为 636.8；大屏二次冻结、媒体快讯；
// 随后六道门禁、申诉（驳回）、技术代表认证唯一正式版本、亚洲纪录认定。
// 全部时刻为 UTC，赛区时区 Asia/Shanghai（UTC+8），上午场 09:00 本地 = 01:00Z。

import { createEvent, EVENT_TYPES, VOID_REASONS } from "../domain/events.js";

export const SCENARIO = {
  timezone: "Asia/Shanghai",
  ruleVersion: "ISSF-RIFLE-2022",
  competitionId: "CMP-2023-AR60W",
  referee: { id: "R-001", role: "REFEREE" },
  jury: { id: "J-001", role: "JURY" },
  td: { id: "TD-001", role: "TECHNICAL_DELEGATE" },
  media: { id: "M-01", role: "MEDIA" },
  recordHolder: "A-CHN-101",
  previousAsianRecordTenths: 6353, // 原亚洲纪录 635.3
};

const T0 = "2023-09-24T00:30:00Z";
const SHOT_START = "2023-09-24T01:00:00Z";
const SHOT_STEP_SECONDS = 50;
const LANE_OFFSET_SECONDS = 4;

function addSeconds(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

// 把差额均匀摊到 n 发上，限制在 [100,109]（10.0–10.9 环）。
function distribute(totalTenths, n, base = 105) {
  const shots = Array(n).fill(base);
  let delta = totalTenths - base * n;
  let i = 0;
  while (delta !== 0) {
    const step = delta > 0 ? 1 : -1;
    shots[i % n] += step;
    if (shots[i % n] < 100 || shots[i % n] > 109) {
      shots[i % n] -= step; // 触边跳过
    } else {
      delta -= step;
    }
    i += 1;
    if (i > n * 40) throw new Error("无法在合法环值内分配总环值");
  }
  return shots;
}

// A101 的六个系列（含补射后的最终值），合计 6368（636.8 环）。
const A101_SERIES = [
  [107, 106, 106, 107, 106, 106, 106, 106, 106, 106], // 106.2
  [107, 107, 106, 106, 107, 106, 106, 107, 107, 106], // 106.5
  [107, 106, 106, 107, 106, 106, 105, 106, 106, 106], // 106.1（第 7 发为补射 10.5）
  [107, 107, 106, 107, 107, 106, 107, 107, 106, 107], // 106.7
  [105, 106, 106, 106, 106, 106, 106, 106, 106, 106], // 105.9
  [105, 105, 106, 106, 105, 105, 106, 105, 105, 106], // 105.4
];

const ATHLETES = [
  { athleteId: "A-CHN-101", bib: "101", teamId: "T-CHN", laneId: "L01", total: 6368 },
  { athleteId: "A-CHN-102", bib: "102", teamId: "T-CHN", laneId: "L02", total: 6294 },
  { athleteId: "A-CHN-103", bib: "103", teamId: "T-CHN", laneId: "L03", total: 6271 },
  { athleteId: "A-KOR-201", bib: "201", teamId: "T-KOR", laneId: "L04", total: 6286 },
  { athleteId: "A-KOR-202", bib: "202", teamId: "T-KOR", laneId: "L05", total: 6269 },
  { athleteId: "A-KOR-203", bib: "203", teamId: "T-KOR", laneId: "L06", total: 6245 },
];

function ev(type, payload, atUtc, actor = SCENARIO.referee, source) {
  return createEvent(type, payload, {
    atUtc,
    actorId: actor.id,
    actorRole: actor.role,
    source,
  });
}

export function buildScenarioEvents() {
  const events = [];
  const push = (...e) => events.push(...e);

  // ---- 开赛与注册 ----
  push(
    ev(
      EVENT_TYPES.COMPETITION_OPENED,
      {
        competitionId: SCENARIO.competitionId,
        name: "女子10米气步枪资格赛（60发）",
        discipline: "AR60W",
        ruleVersion: SCENARIO.ruleVersion,
        startedAtUtc: SHOT_START,
        timezone: SCENARIO.timezone,
        venue: "富阳银湖体育中心",
        recordProtocol: "AR60W_Q_ASIAN_RECORD",
      },
      T0,
    ),
  );

  push(
    ev(EVENT_TYPES.TEAM_REGISTERED, {
      teamId: "T-CHN",
      displayName: "中国队",
      memberIds: ["A-CHN-101", "A-CHN-102", "A-CHN-103"],
    }, T0),
    ev(EVENT_TYPES.TEAM_REGISTERED, {
      teamId: "T-KOR",
      displayName: "韩国队",
      memberIds: ["A-KOR-201", "A-KOR-202", "A-KOR-203"],
    }, T0),
  );

  for (const a of ATHLETES) {
    push(
      ev(EVENT_TYPES.ATHLETE_REGISTERED, {
        athleteId: a.athleteId,
        displayName: `选手${a.bib}`,
        bib: a.bib,
        teamId: a.teamId,
      }, T0),
      ev(EVENT_TYPES.LANE_DEVICE_REGISTERED, {
        laneId: a.laneId,
        deviceId: `ET-${a.laneId}`,
        model: "SIUS HSCORE",
        serial: `SN-${a.bib}-88`,
      }, T0),
      ev(EVENT_TYPES.ATHLETE_LANE_ASSIGNED, { athleteId: a.athleteId, laneId: a.laneId }, T0),
      ev(EVENT_TYPES.CALIBRATION_CHECK, { laneId: a.laneId, verdict: "PASS", driftTenths: 0 }, T0),
      ev(EVENT_TYPES.EQUIPMENT_CHECK, {
        athleteId: a.athleteId,
        verdict: "PASS",
        findings: "气步枪/服装/重量符合规则（细节仅官方可见）",
      }, T0),
    );
  }
  push(ev(EVENT_TYPES.TIME_SYNC_CHECK, { verdict: "PASS", driftMillis: 12 }, T0));
  push(ev(EVENT_TYPES.START_CONFIRMED, {}, SHOT_START));

  // ---- 电子靶原始流 ----
  const shotEvents = [];
  for (const a of ATHLETES) {
    const laneIndex = Number(a.laneId.slice(1)) - 1;
    const values =
      a.athleteId === SCENARIO.recordHolder
        ? A101_SERIES.flat()
        : distribute(a.total, 60, 104);
    values.forEach((tenths, index) => {
      const series = Math.floor(index / 10) + 1;
      const position = (index % 10) + 1;
      // A101 第 3 系列第 7 发：设备异常读数 9.1，之后被作废（补射事件在后面）。
      const isBad = a.athleteId === SCENARIO.recordHolder && series === 3 && position === 7;
      const atUtc = addSeconds(SHOT_START, index * SHOT_STEP_SECONDS + laneIndex * LANE_OFFSET_SECONDS);
      shotEvents.push(
        ev(
          EVENT_TYPES.SHOT_RECORDED,
          {
            athleteId: a.athleteId,
            shotId: `${a.athleteId}-S${series}P${position}`,
            series,
            position,
            tenths: isBad ? 91 : tenths,
            rawTenths: isBad ? 91 : null,
            laneId: a.laneId,
            deviceId: `ET-${a.laneId}`,
          },
          atUtc,
          SCENARIO.referee,
          "electronic-target",
        ),
      );
    });
  }
  shotEvents.sort((x, y) => Date.parse(x.atUtc) - Date.parse(y.atUtc));
  push(...shotEvents);

  const lastShotAt = shotEvents.at(-1).atUtc;
  const finishAt = addSeconds(lastShotAt, 30);

  // ---- 现场大屏：60 发原始结束，显示 635.4（含异常 9.1）----
  push(
    ev(
      EVENT_TYPES.DISPLAY_SNAPSHOT_FROZEN,
      {
        athleteId: SCENARIO.recordHolder,
        label: "资格赛结束·大屏",
        totalTenths: 6354,
        basis: "live-display",
      },
      finishAt,
    ),
  );

  // ---- 追加修正：校准异常 -> 作废 9.1 -> 补射 10.5（原弹与原显示都保留）----
  const inspectAt = addSeconds(finishAt, 120);
  push(
    ev(
      EVENT_TYPES.CALIBRATION_CHECK,
      { laneId: "L01", verdict: "FAIL", driftTenths: 14, note: "第3系列后期换靶后出现 -1.4 环漂移" },
      inspectAt,
    ),
    ev(
      EVENT_TYPES.SHOT_VOIDED,
      {
        athleteId: SCENARIO.recordHolder,
        shotId: `${SCENARIO.recordHolder}-S3P7`,
        reason: VOID_REASONS.CALIBRATION_DRIFT,
        note: "靶位校准漂移期间发射，读数 9.1 不予计入",
      },
      addSeconds(inspectAt, 60),
    ),
    ev(
      EVENT_TYPES.RESHOT_AWARDED,
      {
        athleteId: SCENARIO.recordHolder,
        voidedShotId: `${SCENARIO.recordHolder}-S3P7`,
        replacementShotId: `${SCENARIO.recordHolder}-S3P7-R`,
        reason: VOID_REASONS.CALIBRATION_DRIFT,
      },
      addSeconds(inspectAt, 60),
    ),
  );
  const recalibratedAt = addSeconds(inspectAt, 180);
  push(
    ev(EVENT_TYPES.CALIBRATION_CHECK, { laneId: "L01", verdict: "PASS", driftTenths: 0, note: "重新校准合格" }, recalibratedAt),
    ev(
      EVENT_TYPES.SHOT_RECORDED,
      {
        athleteId: SCENARIO.recordHolder,
        shotId: `${SCENARIO.recordHolder}-S3P7-R`,
        series: 3,
        position: 7,
        tenths: 105,
        laneId: "L01",
        deviceId: "ET-L01",
      },
      addSeconds(recalibratedAt, 90),
      SCENARIO.referee,
      "electronic-target-reshot",
    ),
  );
  const reshotAt = addSeconds(recalibratedAt, 90);

  // 裁判逐发签名（计分发，含补射；作废弹不签）
  for (const a of ATHLETES) {
    const ids = [];
    for (let s = 1; s <= 6; s += 1) {
      for (let p = 1; p <= 10; p += 1) {
        if (a.athleteId === SCENARIO.recordHolder && s === 3 && p === 7) continue; // 作废
        ids.push(`${a.athleteId}-S${s}P${p}`);
      }
    }
    if (a.athleteId === SCENARIO.recordHolder) ids.push(`${SCENARIO.recordHolder}-S3P7-R`);
    push(
      ev(
        EVENT_TYPES.SHOTS_SIGNED,
        { athleteId: a.athleteId, shotIds: ids },
        addSeconds(reshotAt, 60 + ATHLETES.indexOf(a) * 5),
      ),
    );
  }
  const signedAt = addSeconds(reshotAt, 120);

  // ---- 二次冻结 636.8 与媒体快讯（快讯不构成认定）----
  push(
    ev(
      EVENT_TYPES.DISPLAY_SNAPSHOT_FROZEN,
      { athleteId: SCENARIO.recordHolder, label: "补射后·大屏", totalTenths: 6368, basis: "live-display" },
      signedAt,
    ),
    ev(
      EVENT_TYPES.MEDIA_FLASH_PUBLISHED,
      {
        flashId: "FLASH-6368",
        athleteId: SCENARIO.recordHolder,
        headline: "636.8环！女子10米气步枪资格赛刷新亚洲纪录",
        claimedTotalTenths: 6368,
        outlet: "赛场快讯",
        basis: "live-display",
      },
      addSeconds(signedAt, 20),
      SCENARIO.media,
      "media-wire",
    ),
  );

  // ---- 发布成绩版本（待确认，申诉窗口 10 分钟）----
  const publishedAt = addSeconds(signedAt, 120);
  const deadline = addSeconds(publishedAt, 600);
  push(
    createEvent(
      EVENT_TYPES.VERSION_PUBLISHED,
      {
        versionId: "V-Q-001",
        label: "资格赛成绩·初版",
        kind: "QUALIFICATION_RESULT",
        protestWindowMinutes: 10,
        protestDeadlineUtc: deadline,
      },
      { atUtc: publishedAt, actorId: SCENARIO.referee.id, actorRole: SCENARIO.referee.role, source: "result-system" },
    ),
  );

  // 申诉：A-KOR-201 对排名提出申诉，仲裁驳回（窗口内提出、窗口内裁决）
  push(
    createEvent(
      EVENT_TYPES.PROTEST_FILED,
      {
        protestId: "PRT-001",
        athleteId: "A-KOR-201",
        againstVersionId: "V-Q-001",
        reason: "对第5系列两发计分有异议",
      },
      {
        atUtc: addSeconds(publishedAt, 150),
        actorId: "A-KOR-201",
        actorRole: "ATHLETE",
        source: "protest-desk",
      },
    ),
    createEvent(
      EVENT_TYPES.PROTEST_RESOLVED,
      { protestId: "PRT-001", verdict: "REJECTED", note: "复核弹着图像与签名数据，计分无误" },
      {
        atUtc: addSeconds(publishedAt, 360),
        actorId: SCENARIO.jury.id,
        actorRole: SCENARIO.jury.role,
        source: "jury-room",
      },
    ),
  );

  // ---- 六道门禁证据与签名 ----
  const gate = (gateName, payload, actor, atUtc) =>
    createEvent(
      EVENT_TYPES.GATE_EVIDENCE_SUBMITTED,
      { versionId: "V-Q-001", gate: gateName, verdict: "PASS", ...payload },
      { atUtc, actorId: actor.id, actorRole: actor.role, source: "jury-paperwork" },
    );
  push(
    gate("IDENTITY", { reference: "IDX-2023-0924", note: "号码布/靶位/注册一致" }, SCENARIO.referee, addSeconds(publishedAt, 60)),
    gate("DEVICE", { reference: "CAL-L01..L06", note: "L01 漂移已恢复并重测合格" }, SCENARIO.referee, addSeconds(publishedAt, 90)),
    gate("SHOT_DATA", { reference: "SIGN-ALL", note: "360 发计分发全部签名，补射链完整" }, SCENARIO.referee, addSeconds(publishedAt, 120)),
    gate("TIME_SYNC", { reference: "NTP-PTP", note: "各靶偏差 ≤ 12ms" }, SCENARIO.referee, addSeconds(publishedAt, 150)),
    gate("EQUIPMENT", { reference: "EQ-ALL", note: "六人器材检查 PASS" }, SCENARIO.referee, addSeconds(publishedAt, 180)),
  );
  // 申诉窗口门禁：截止时刻之后由仲裁签署
  push(
    gate(
      "PROTEST_WINDOW",
      { reference: "PRT-001", note: "窗口已关闭，PRT-001 已驳回，无未决申诉" },
      SCENARIO.jury,
      addSeconds(deadline, 30),
    ),
  );

  // ---- 技术代表认证唯一正式版本 + 亚洲纪录认定 ----
  const certifiedAt = addSeconds(deadline, 90);
  push(
    createEvent(EVENT_TYPES.VERSION_CERTIFIED, { versionId: "V-Q-001" }, {
      atUtc: certifiedAt,
      actorId: SCENARIO.td.id,
      actorRole: SCENARIO.td.role,
      source: "td-office",
    }),
    createEvent(
      EVENT_TYPES.RECORD_RATIFIED,
      {
        versionId: "V-Q-001",
        athleteId: SCENARIO.recordHolder,
        recordType: "ASIAN_RECORD_AR60W_QUALIFICATION",
        certificateId: "AR-2023-0042",
      },
      {
        atUtc: addSeconds(certifiedAt, 120),
        actorId: SCENARIO.td.id,
        actorRole: SCENARIO.td.role,
        source: "td-office",
      },
    ),
  );

  return events;
}
