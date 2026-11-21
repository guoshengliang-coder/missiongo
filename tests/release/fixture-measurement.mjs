// Only the synthetic installed-entry test uses this helper. The production
// release CLI still rejects every exceeded target and invalid calibration.
export function fixtureMeasurementReport(result) {
  // Coordinator output may contain a preceding preflight JSON document. The
  // pretty-printed CLI puts only top-level objects at the start of a line.
  for (const text of (result.stdout ?? "").split(/(?=^\{)/m).reverse()) {
    try {
      const report = JSON.parse(text);
      if (report.calibration && report.httpCalibration && Array.isArray(report.stages)) return report;
    } catch { /* Incomplete output is not measurement evidence. */ }
  }
  return null;
}

export function resampleFixtureOnce(run, { purpose, rejected }) {
  if (!["version-guard", "diagnostic-calibration"].includes(purpose)) throw new Error("Unknown fixture measurement purpose");
  const first = run(), report = fixtureMeasurementReport(first);
  const stages = ["settings", "discovery", "transfer", "validation", "compile", "measurement", "cleanup"];
  const complete = report && first.status === 1 && !first.signal && !first.error
    && report.version === 2 && [report.calibration?.valid, report.httpCalibration?.valid].every(v => typeof v === "boolean")
    && Number.isFinite(report.totalMs) && report.totalMs >= 0 && Number.isFinite(report.limits?.maxDurationMs)
    && report.totalMs < report.limits.maxDurationMs && report.stages?.length === stages.length
    && report.cleaned === true && report.cleanupSucceeded === true
    && ["regression", "measurement"].includes(report.failureKind)
    && report.cpuTargets?.length === 3 && report.httpTargets?.length === 4
    && stages.every(name => report.stages?.filter(s => s.name === name).length === 1
      && report.stages.find(s => s.name === name).status === (name === "measurement" ? "failed" : "passed"));
  const eligible = complete && (purpose === "version-guard"
    ? report.status === "failed" && !report.experiment
    : report.status === "invalid" && report.measurementStatus === "failed" && report.diagnosticOutcome === "not_detected"
      && /^release-fivefold-(merge-deliveries|item-list|claim-next)$/.test(report.experiment ?? "")
      && (report.calibration?.valid === false || report.httpCalibration?.valid === false));
  if (!eligible) return first;
  // Preserve the rejected observation, verify the no-write boundary, and make
  // one fresh measurement. Never turn an unsuccessful final result into pass.
  rejected(report);
  return run();
}
