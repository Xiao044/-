const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const jobsPath = path.join(dataDir, 'generation-jobs.json');

const PLATFORM_TERMINAL_SUCCESS = new Set(['completed']);
const PLATFORM_TERMINAL_FAILURE = new Set(['login_required', 'not_open', 'upload_error', 'submit_error', 'result_timeout', 'adapter_error', 'import_error', 'failed']);
const PLATFORM_ACTIVE = new Set(['checking_login', 'page_opened', 'filling', 'submitted', 'generating', 'result_ready', 'running']);

const deriveStatus = (platforms) => {
  const entries = platforms && typeof platforms === 'object' && !Array.isArray(platforms)
    ? Object.values(platforms).filter((item) => item && typeof item === 'object')
    : [];
  const statuses = entries.map((item) => item.status);
  if (!statuses.length || statuses.every((status) => status === 'queued')) return 'queued';
  if (statuses.every((status) => PLATFORM_TERMINAL_SUCCESS.has(status))) return 'completed';
  if (statuses.every((status) => PLATFORM_TERMINAL_SUCCESS.has(status) || PLATFORM_TERMINAL_FAILURE.has(status))) return 'failed';
  if (statuses.some((status) => PLATFORM_ACTIVE.has(status)) || statuses.some((status) => status === 'queued')) return 'running';
  return 'running';
};

const countStatuses = (jobs, selector) => {
  const counts = {};
  for (const job of Object.values(jobs)) {
    const status = selector(job);
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
};

if (!fs.existsSync(jobsPath)) {
  console.error(`generation jobs file not found: ${jobsPath}`);
  process.exit(1);
}

const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) {
  console.error('generation jobs file must contain an object');
  process.exit(1);
}

const beforeStatuses = countStatuses(jobs, (job) => job?.status || 'missing');
const derivedStatuses = countStatuses(jobs, (job) => deriveStatus(job?.platforms));
const mismatchedJobIds = Object.entries(jobs)
  .filter(([, job]) => (job?.status || 'missing') !== deriveStatus(job?.platforms))
  .map(([key]) => key);

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const backupPath = path.join(dataDir, `generation-jobs.json.backup-${stamp}`);
fs.copyFileSync(jobsPath, backupPath);

const normalizedJobs = Object.fromEntries(Object.entries(jobs).map(([key, job]) => [
  key,
  job && typeof job === 'object' && !Array.isArray(job) ? { ...job, status: deriveStatus(job.platforms) } : job
]));
const temporaryPath = `${jobsPath}.tmp`;
fs.writeFileSync(temporaryPath, JSON.stringify(normalizedJobs, null, 2), 'utf8');
fs.renameSync(temporaryPath, jobsPath);

console.log(JSON.stringify({
  jobs: Object.keys(jobs).length,
  mismatched: mismatchedJobIds.length,
  beforeStatuses,
  derivedStatuses,
  afterStatuses: countStatuses(normalizedJobs, (job) => job?.status || 'missing'),
  backupPath,
  mismatchedJobIds
}, null, 2));
