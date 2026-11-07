'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- Linux proc files for recorded owned child births only. */
const fs = require('node:fs');
const crypto = require('node:crypto');
function processIdentity (pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('WHOLE_C_WRITER_PID');
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, state: fields[0], startTicks: fields[19], uid: fs.statSync('/proc/' + pid).uid,
      commandDigest: crypto.createHash('sha256').update(fs.readFileSync('/proc/' + pid + '/cmdline')).digest('hex') };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
function stoppedWindow ({ tenant, births, observe = processIdentity, onObservation = () => {} }) {
  if (!Array.isArray(births) || !births.length || births.some(birth => !birth || !Number.isSafeInteger(birth.pid) || !/^\d+$/.test(birth.startTicks || '') || !Number.isInteger(birth.uid) || !/^[a-f0-9]{64}$/.test(birth.commandDigest || '') || birth.kind !== 'owned-sql-fixture-writer') || new Set(births.map(b => b.pid)).size !== births.length) throw new Error('WHOLE_C_WRITER_BIRTHS');
  return async request => {
    const observations = births.map(birth => ({ birth, current: observe(birth.pid) }));
    await onObservation(observations);
    const held = observations.every(({ birth, current }) => !current || (current.startTicks === birth.startTicks && current.uid === birth.uid && current.commandDigest === birth.commandDigest && ['T', 't', 'Z'].includes(current.state)));
    return { tenant, current: request.tenant === tenant && held, quiesced: request.tenant === tenant && held };
  };
}
module.exports = { processIdentity, stoppedWindow };
