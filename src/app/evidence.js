import { computeAthleteResult } from "../domain/aggregate.js";
import { evaluateGates, GATE_ORDER, GATE_TITLES } from "../domain/gates.js";
import { formatRing, formatTotal, resolveRuleVersion } from "../domain/rules.js";
import { formatInstant } from "../domain/clock.js";

// 技术代表证据包：给定版本（可进一步聚焦某运动员/纪录），重放全部依据。
// 1) 链完整性校验；2) 独立重算并与版本快照逐发对账；
// 3) 校准/时间同步证据；4) 门禁数据与签名；5) 认证与认定批准；6) 现场显示与快讯。
export function buildEvidencePackage(store, { versionId, athleteId = null, nowUtc = new Date().toISOString() } = {}) {
  const state = store.replay();
  const chain = store.verifyChain();
  const version = state.versions.get(versionId);
  if (!version) {
    const err = new Error(`版本不存在: ${versionId}`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const timezone = state.competition.timezone;
  const targets = athleteId ? [athleteId] : [...version.results.keys()];
  const computations = targets.map((id) => {
    const athlete = state.athletes.get(id);
    const published = version.results.get(id);
    // 独立重算：不信任版本内封存的快照。
    const recomputed = computeAthleteResult(state, athlete, version.results.get(id).ruleVersion);
    return {
      athleteId: id,
      name: athlete?.displayName ?? null,
      bib: athlete?.bib ?? null,
      laneId: athlete?.laneId ?? null,
      consistent:
        recomputed.totalTenths === published.totalTenths &&
        recomputed.subtotalTenths === published.subtotalTenths &&
        recomputed.deductionTenths === published.deductionTenths &&
        JSON.stringify(recomputed.seriesTotals) === JSON.stringify(published.seriesTotals),
      totals: {
        subtotal: formatTotal(recomputed.subtotalTenths),
        deduction: formatTotal(recomputed.deductionTenths),
        total: formatTotal(recomputed.totalTenths),
        innerTen: recomputed.innerTen,
      },
      series: recomputed.seriesTotals.map((t, i) => ({
        series: i + 1,
        total: formatTotal(t),
        shots: recomputed.seriesShots[i].map((s) => ({
          shotId: s.shotId,
          position: s.position,
          ring: formatRing(s.tenths),
          at: formatInstant(s.atUtc, timezone),
          deviceId: s.deviceId,
          signed: athlete.signatures.get(s.shotId)
            ? { refereeId: athlete.signatures.get(s.shotId).refereeId, at: athlete.signatures.get(s.shotId).atUtc }
            : null,
          voided: athlete.voided.get(s.shotId) ?? null,
        })),
      })),
      corrections: {
        voidedShots: [...athlete.voided.entries()].map(([shotId, info]) => ({ shotId, ...info })),
        reshots: athlete.reshots,
        penalties: athlete.penalties,
        withdrawn: athlete.withdrawn
          ? { reason: athlete.withdrawnReason, atUtc: athlete.withdrawnAtUtc }
          : null,
      },
      anomalies: recomputed.anomalies,
      frozenDisplays: athlete.displaySnapshots.map((d) => ({
        label: d.label,
        shown: formatTotal(d.totalTenths),
        at: formatInstant(d.atUtc, timezone),
        basis: d.basis,
      })),
    };
  });

  // 靶位设备与校准时间线（仅涉及目标运动员的靶位）。
  const laneIds = [...new Set(targets.map((id) => state.athletes.get(id)?.laneId).filter(Boolean))];
  const devices = laneIds.map((laneId) => {
    const device = state.devices.get(laneId);
    return {
      laneId,
      deviceId: device.deviceId,
      model: device.model,
      serial: device.serial,
      checks: device.checks.map((c) => ({
        kind: c.kind,
        verdict: c.verdict,
        at: formatInstant(c.atUtc, timezone),
        drift: c.kind === "CALIBRATION" ? `${formatRing(c.driftTenths ?? 0)} 环` : `${c.driftMillis ?? 0} ms`,
        inspectorId: c.inspectorId,
        note: c.note,
      })),
    };
  });

  const gateEvaluation = evaluateGates(state, version, { nowUtc });
  const gateEvidence = GATE_ORDER.map((gate) => ({
    gate,
    title: GATE_TITLES[gate],
    evaluation: gateEvaluation.find((g) => g.gate === gate),
    submissions: (state.gateEvidence ?? [])
      .filter((e) => e.versionId === versionId && e.gate === gate)
      .map((e) => ({ by: e.by, at: formatInstant(e.atUtc, timezone), verdict: e.verdict, reference: e.reference, note: e.note })),
  }));

  const protests = [...state.protests.values()]
    .filter((p) => !p.againstVersionId || p.againstVersionId === versionId)
    .map((p) => ({
      protestId: p.protestId,
      athleteId: p.athleteId,
      status: p.status,
      filedAt: formatInstant(p.filedAtUtc, timezone),
      resolution: p.resolution
        ? { verdict: p.resolution.verdict, by: p.resolution.by, at: formatInstant(p.resolution.atUtc, timezone) }
        : null,
    }));

  const record = athleteId
    ? state.ratifications.find((r) => r.versionId === versionId && r.athleteId === athleteId) ?? null
    : state.ratifications.filter((r) => r.versionId === versionId);

  return {
    package: "TECHNICAL_DELEGATE_EVIDENCE_REPLAY",
    generatedAtUtc: nowUtc,
    competition: {
      id: state.competition.id,
      name: state.competition.name,
      ruleVersion: state.competition.ruleVersion,
      rule: resolveRuleVersion(state.competition.ruleVersion, state.competition.startedAtUtc).name,
      timezone,
    },
    version: {
      versionId,
      label: version.label,
      kind: version.kind,
      publishedBy: version.publishedBy,
      publishedAt: formatInstant(version.atUtc, timezone),
      protestDeadline: version.protestDeadlineUtc ? formatInstant(version.protestDeadlineUtc, timezone) : null,
    },
    certification: state.certifications?.get(versionId)
      ? {
          by: state.certifications.get(versionId).by,
          at: formatInstant(state.certifications.get(versionId).atUtc, timezone),
        }
      : null,
    record,
    gateEvidence,
    protests,
    devices,
    computations,
    flashes: state.flashes.map((f) => ({
      headline: f.headline,
      outlet: f.outlet,
      claimed: formatTotal(f.claimedTotalTenths),
      at: formatInstant(f.atUtc, timezone),
      note: "快讯仅为播报记录，非成绩依据",
    })),
    chain: {
      intact: chain.ok,
      eventCount: chain.count ?? store.length,
      head: chain.head ?? store.headHash(),
      brokenAt: chain.ok ? null : chain.brokenAt,
    },
    eventTimeline: store.records().map((r) => ({
      seq: r.seq,
      type: r.event.type,
      atUtc: r.event.atUtc,
      actorId: r.event.actorId,
      hash: r.hash,
    })),
  };
}
