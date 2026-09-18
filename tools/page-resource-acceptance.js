'use strict';

// Measured d79b8a74/b9f48190 prototype on Chromium 153. Recalibrate only
// through a reviewed matched comparison, not automatically from new output.
const heapLimits = {app: 5500000, reports: 4850000, admin: 5050000, profile: 5050000, food: 6400000};
const median = values => {
  const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const completeRuns = (rows, samples) => rows.length === samples && new Set(rows.map(row => row.run)).size === samples && rows.every(row => Number.isInteger(row.run) && row.run >= 0 && row.run < samples);

function startup(rows, samples) {
  if (samples < 7) return {assessed: false, reason: 'At least seven paired samples are required'};
  const comparisons = Object.entries(heapLimits).map(([entry, heapLimit]) => {
    const parent = rows.filter(row => row.label === 'parent' && row.entry === entry);
    const candidate = rows.filter(row => row.label === 'candidate' && row.entry === entry);
    if (!completeRuns(parent, samples) || !completeRuns(candidate, samples)) return {entry, pass: false, reason: 'Incomplete page sample set'};
    const parentTimes = parent.map(row => row.startupMs).sort((a, b) => a - b);
    const parentIQR = parentTimes[Math.floor(samples * 0.75)] - parentTimes[Math.floor(samples * 0.25)];
    // Two animation frames can change the observed ready time by ~33ms.
    // A slower host is compared with its own matched parent, not Mac timings.
    const startupLimit = median(parentTimes) + Math.max(33, 2 * parentIQR);
    const candidateStartup = median(candidate.map(row => row.startupMs));
    const candidateHeap = Math.max(...candidate.map(row => row.heap.usedSize));
    return {entry, parentIQRMs: parentIQR, startupMedianMs: candidateStartup, startupLimitMs: startupLimit,
      maxHeapBytes: candidateHeap, heapLimitBytes: heapLimit, pass: candidateStartup <= startupLimit && candidateHeap <= heapLimit};
  });
  return {assessed: true, pass: comparisons.every(row => row.pass), comparisons};
}

function journey(rows, samples) {
  if (samples < 7) return {assessed: false, reason: 'At least seven paired samples are required'};
  const candidate = rows.filter(row => row.label === 'candidate');
  if (!completeRuns(candidate, samples) || !completeRuns(rows.filter(row => row.label === 'parent'), samples)) return {assessed: true, pass: false, reason: 'Incomplete journey sample set'};
  const expected = ['initial:app', 'firstVisit:reports', 'firstVisit:admin', 'firstVisit:profile', 'firstVisit:food',
    'cachedVisit:app', 'cachedVisit:reports', 'cachedVisit:admin', 'cachedVisit:profile', 'cachedVisit:food'].join(',');
  if (rows.some(row => row.steps.map(step => step.phase + ':' + step.entry).join(',') !== expected)) return {assessed: true, pass: false, reason: 'Incomplete page journey'};
  const nonPollingRequests = Math.max(...candidate.map(row => row.nonPollingRequests));
  const responseBodyBytes = Math.max(...candidate.map(row => row.totalResponseBodyBytes));
  const cachedBundleRequests = candidate.flatMap(row => row.steps).filter(step => step.phase === 'cachedVisit').reduce((sum, step) => sum + step.bundleRequests.length, 0);
  return {assessed: true, pass: nonPollingRequests <= 190 && responseBodyBytes <= 1500000 && cachedBundleRequests === 0,
    nonPollingRequests, requestLimit: 190, responseBodyBytes, responseBodyLimit: 1500000, cachedBundleRequests};
}

module.exports = {startup, journey, heapLimits};
