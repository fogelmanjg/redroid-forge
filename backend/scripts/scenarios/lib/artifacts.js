'use strict';

// The Codec2 component that hwenc injects into /vendor of every instance is NOT built by redroid-forge: it comes
// from an AOSP build (REDROID_HWENC_ARTIFACTS_DIR). If that build is older than the last change to the component's
// source (android/vaapi_codec2), what a scenario measures is the OLD component, not the code of the checkout --
// e.g. an encoder that never sends the bitrate to the rate control. This check says so instead of letting a run
// that does not measure what it claims pass quietly.

const { execFileSync } = require('child_process');
const path = require('path');
const { q } = require('./host');

const SERVICE = 'bin/hw/android.hardware.media.c2-vaapi-service';

// The source files whose change makes the artifacts stale FOR WHAT A SCENARIO USES: a scenario that only decodes
// is not affected by a change to the encoder, and flagging it would be noise that teaches to ignore the warning.
const SOURCES = {
  encode: ['android/vaapi_codec2/component/VaapiEncComponent.cpp', 'android/vaapi_codec2/component/VaapiEncComponent.h'],
  decode: ['android/vaapi_codec2/component/VaapiDecComponent.cpp', 'android/vaapi_codec2/component/VaapiDecComponent.h'],
  common: ['android/vaapi_codec2/service'],
};

function sourcesFor(kinds) {
  const wanted = new Set(['common', ...kinds.filter((k) => SOURCES[k])]);
  return [...wanted].flatMap((k) => SOURCES[k]);
}

// Pure: -> a check object ({id, verdict, detail}). Stale artifacts are a WARNING, not a failure: they do not say that the
// system under test is wrong, they say that the run may not be measuring the code of this checkout -- and the change
// that made them stale can be as harmless as a translated comment. When it does matter (e.g. an encoder that never
// receives the bitrate) the daemon's own report catches it, as a failure, in lib/criteria.js.
function compare({ builtAt, sourceAt, sourceCommit }) {
  const fmt = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
  if (!builtAt) return { id: 'hwencArtifactsCurrent', verdict: 'unknown', detail: 'the date of the hwenc artifacts could not be read on the host' };
  if (!sourceAt) return { id: 'hwencArtifactsCurrent', verdict: 'unknown', detail: 'the date of the last change to the component could not be read (not a git checkout?)' };
  if (builtAt < sourceAt) {
    return {
      id: 'hwencArtifactsCurrent',
      verdict: 'warn',
      detail: `the hwenc artifacts were built on ${fmt(builtAt)}, BEFORE the last change to the Android component (${sourceCommit}, ${fmt(sourceAt)}): `
        + 'the instances run the older component, so this run may not measure the code of this checkout (rebuild the artifacts to be sure)',
    };
  }
  return { id: 'hwencArtifactsCurrent', verdict: 'pass', detail: `the hwenc artifacts (${fmt(builtAt)}) are newer than the last change to the component (${fmt(sourceAt)})` };
}

async function artifactsCheck(host, artifactsDir, repoRoot, kinds = ['encode', 'decode']) {
  const r = await host.run(`stat -c %Y ${q(path.posix.join(artifactsDir, SERVICE))}`);
  const builtAt = Number(r.stdout.trim()) || null;
  let sourceAt = null;
  let sourceCommit = null;
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'log', '-1', '--format=%ct %h', '--', ...sourcesFor(kinds)], { encoding: 'utf-8' }).trim().split(' ');
    sourceAt = Number(out[0]) || null;
    sourceCommit = out[1] || null;
  } catch { /* not a git checkout */ }
  return compare({ builtAt, sourceAt, sourceCommit });
}

module.exports = { artifactsCheck, compare, sourcesFor };
