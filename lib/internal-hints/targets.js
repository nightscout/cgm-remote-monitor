'use strict';

// Hint targets from the environment (decisions statefulset-ordinal-scaling,
// config-few-dozen-env). K for each target role is the value that also sets
// that StatefulSet's replicas; ordinal i is reached through the headless
// Service naming, given as one URL template with {i}:
//
//   NS_EVALUATOR_SLICES      evaluator K (the setting lib/pgstream/assigned-worker.js reads)   1
//   NS_EVALUATOR_SLICE_URL   evaluator ordinal i, e.g. http://evaluator-{i}.evaluator:19002/   required when K > 1
//   NS_REALTIME_SLICES       realtime K (realtime itself reads NS_SLICE_COUNT)                1
//   NS_REALTIME_SLICE_URL    realtime ordinal i, e.g. http://realtime-{i}.realtime-peers:19003/
//   NS_REALTIME_SLICE_PEERS  the existing explicit realtime roster (lib/realtime-ownership peers());
//                            when set it is the roster and K is its length
//
// At K = 1 the one peer is the role's ordinary internal address:
// NS_<ROLE>_INTERNAL_URL, else NS_<ROLE>_INTERNAL_SOCKET, else the default
// socket <runtime>/<role>.sock (the same rule as lib/server/internal-api/listener-config.js).
// A role this process serves is a local function call (`local`), never HTTP.
const path = require('node:path');
const slice = require('../pool-membership/slice');

const COUNT = /^[1-9][0-9]{0,3}$/;
const refuse = message => { throw new TypeError('internal hints: ' + message); };
const read = (source, name) => {
  const value = source && Object.hasOwn(source, name) ? String(source[name]).trim() : '';
  return value === '' ? undefined : value;
};
function runtimeDirectory (source) {
  const xdg = read(source, 'XDG_RUNTIME_DIR');
  return xdg && path.isAbsolute(xdg) ? path.join(xdg, 'nightscout') : '/run/nightscout';
}
function single (role, source) {
  const prefix = 'NS_' + role.toUpperCase() + '_INTERNAL_';
  const url = read(source, prefix + 'URL'), socket = read(source, prefix + 'SOCKET');
  if (url !== undefined && socket !== undefined) refuse(prefix + 'URL and ' + prefix + 'SOCKET are exclusive');
  if (url !== undefined) return { url };
  return { socketPath: socket !== undefined ? socket : path.join(runtimeDirectory(source), role + '.sock') };
}
function count (source, name) {
  const raw = read(source, name);
  if (raw === undefined) return 1;
  if (!COUNT.test(raw)) refuse(name + ' must be a whole number from 1');
  const value = Number(raw);
  try { slice.shape(value, 0); } catch { refuse(name + ' must be at most ' + slice.MAX_MEMBERS); }
  return value;
}
function template (source, name) {
  const text = read(source, name);
  if (text === undefined) refuse(name + ' is required when the slice count is above 1');
  if (!text.includes('{i}')) refuse(name + ' must contain {i}');
  return i => ({ url: text.split('{i}').join(String(i)) });
}

// targets(source, {local: {evaluator?, realtime?}, ordinal: {evaluator?, realtime?}})
// -> {evaluator, realtime} for sender.create({targets}).
function fromEnvironment (source = process.env, { local = {}, ordinal = {} } = {}) {
  const out = {};
  {
    const k = count(source, 'NS_EVALUATOR_SLICES');
    const address = k === 1 ? () => single('evaluator', source) : template(source, 'NS_EVALUATOR_SLICE_URL');
    out.evaluator = { count: k, address, ...(local.evaluator ? { local: local.evaluator } : {}), ...(ordinal.evaluator !== undefined ? { ordinal: ordinal.evaluator } : {}) };
  }
  {
    const roster = read(source, 'NS_REALTIME_SLICE_PEERS');
    let k, address;
    if (roster !== undefined) {
      let list; try { list = JSON.parse(roster); } catch { refuse('NS_REALTIME_SLICE_PEERS must be JSON'); }
      if (!Array.isArray(list) || !list.length || list.length > slice.MAX_MEMBERS) refuse('NS_REALTIME_SLICE_PEERS must be a non-empty list');
      const declared = read(source, 'NS_REALTIME_SLICES');
      if (declared !== undefined && Number(declared) !== list.length) refuse('NS_REALTIME_SLICES disagrees with NS_REALTIME_SLICE_PEERS');
      k = list.length; address = i => list[i];
    } else {
      k = count(source, 'NS_REALTIME_SLICES');
      address = k === 1 ? () => single('realtime', source) : template(source, 'NS_REALTIME_SLICE_URL');
    }
    out.realtime = { count: k, address, ...(local.realtime ? { local: local.realtime } : {}), ...(ordinal.realtime !== undefined ? { ordinal: ordinal.realtime } : {}) };
  }
  // A role served in this process with no ordinal serves every slice: local only.
  for (const role of Object.keys(out)) if (out[role].local && out[role].ordinal === undefined) delete out[role].address;
  return out;
}

module.exports = { fromEnvironment };
