// Only actual successful builds can anchor reuse. A green planned-skip summary
// cannot anchor another skip, so no recursive trust chain or failed gap is hidden.
const shaPattern = /^[a-f0-9]{40}$/;
const fullJobs = ['web-and-server', 'ui', 'android', 'macos', 'linux-node',
  'android-build', 'macos-build', 'linux-node (ubuntu-22.04)', 'linux-node (ubuntu-24.04)'];
export function fullBuildEvidence(jobs, run) {
  return fullJobs.every(name => {
    const matches = jobs.filter(j => j.name === name);
    return matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success'
      && matches[0].head_sha === run.head_sha && matches[0].run_id === run.id;
  });
}
export function validBaseline(value, head) {
  return value?.kind === 'full-main-build' && shaPattern.test(value.sha ?? '') && value.sha !== head
    && Number.isSafeInteger(value.runId) && value.runId > 0 && Number.isSafeInteger(value.attempt) && value.attempt > 0;
}
export async function findFullMainBaseline({ repository, head, token, isAncestor, fetcher = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !shaPattern.test(head ?? '') || !token) throw new Error('Missing baseline API identity');
  const signal = AbortSignal.timeout(15_000);
  const get = async path => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10' }, signal });
    if (!response.ok) throw new Error(`Baseline API returned ${response.status}`);
    return response.json();
  };
  const data = await get('actions/workflows/ci.yml/runs?branch=main&status=success&per_page=20');
  if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid baseline run response');
  let inspected = 0;
  for (const run of data.workflow_runs) {
    if (!['push', 'schedule'].includes(run.event) || run.head_branch !== 'main' || run.path !== '.github/workflows/ci.yml'
      || run.status !== 'completed' || run.conclusion !== 'success' || run.repository?.full_name !== repository
      || !shaPattern.test(run.head_sha ?? '') || run.head_sha === head || !Number.isSafeInteger(run.id) || run.id <= 0
      || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0 || !isAncestor(run.head_sha, head)) continue;
    if (++inspected > 10) break;
    const payload = await get(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    // Partial reruns and incomplete/paginated evidence cannot be full anchors.
    if (!Array.isArray(payload.jobs) || payload.total_count !== payload.jobs.length || payload.total_count >= 100) continue;
    if (fullBuildEvidence(payload.jobs, run)) return { kind: 'full-main-build', sha: run.head_sha, runId: run.id, attempt: run.run_attempt };
  }
  return null;
}
