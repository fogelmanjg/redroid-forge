'use strict';

// Backup / restore as background jobs (1.0.0-beta.8). Both used to run inside the HTTP request:
// with a whole /data of several GB the browser waited minutes with no feedback, and anything that
// cut the request (a proxy timeout, closing the tab) gave no answer about how it ended. Now the
// route starts a job and answers right away; the page polls GET /api/instances/:id/backup-job.
//
// One job per instance at a time (a second one gets 409). A finished job stays readable for
// KEEP_FINISHED_MS so the page can show how it ended, then it is forgotten.

const crypto = require('crypto');

const KEEP_FINISHED_MS = 30 * 60 * 1000;

const jobs = new Map(); // instanceId -> job

function httpError(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function publicView(job) {
  if (!job) return null;
  const { timer, ...rest } = job;
  return { ...rest, elapsedMs: (job.finishedAt || Date.now()) - job.startedAt };
}

function current(instanceId) {
  return publicView(jobs.get(instanceId));
}

function isRunning(instanceId) {
  const j = jobs.get(instanceId);
  return !!j && j.state === 'running';
}

// `work(job)` does the job and may set job.phase / job.bytesTotal / job.bytesDone along the way;
// whatever it returns becomes job.result. Errors become job.error (never thrown to the caller).
function start(instanceId, kind, work, { log = console } = {}) {
  if (isRunning(instanceId)) {
    const j = jobs.get(instanceId);
    throw httpError(`A ${j.kind} of this instance is already in progress -- wait for it to finish.`, 409);
  }
  const prev = jobs.get(instanceId);
  if (prev && prev.timer) clearTimeout(prev.timer);
  const job = {
    id: crypto.randomBytes(8).toString('hex'), instanceId, kind, state: 'running', phase: null,
    startedAt: Date.now(), finishedAt: null, bytesTotal: null, bytesDone: 0, result: null, error: null,
  };
  jobs.set(instanceId, job);
  const done = () => {
    job.finishedAt = Date.now();
    job.timer = setTimeout(() => { if (jobs.get(instanceId) === job) jobs.delete(instanceId); }, KEEP_FINISHED_MS);
    if (job.timer.unref) job.timer.unref();
  };
  Promise.resolve()
    .then(() => work(job))
    .then((result) => { job.result = result === undefined ? null : result; job.state = 'done'; done(); })
    .catch((e) => {
      job.error = e && e.message ? e.message : String(e);
      job.state = 'error';
      log.warn(`[backupJobs] ${kind} of ${instanceId} failed: ${job.error}`);
      done();
    });
  return publicView(job);
}

// The job owns the instance (a restore, a stop-first backup): start/restart refuse meanwhile.
function markBlocking(instanceId) {
  const j = jobs.get(instanceId);
  if (j && j.state === 'running') j.blocksStart = true;
}

module.exports = { start, current, isRunning, markBlocking, KEEP_FINISHED_MS };
