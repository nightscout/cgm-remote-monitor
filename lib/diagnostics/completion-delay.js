'use strict';

// Measurement control (alignment brief mt-plannable-scale-20261121, E3): a
// fixed wait the evaluator inserts before each durable completion, so a
// latency instrument can be shown to see a known delay. Test and harness use
// only. Unset, empty or 0 is off and the evaluator adds no step; anything
// other than an integer 0..120000 refuses boot.
const KEY = 'NS_TEST_EVALUATOR_COMPLETION_DELAY_MS';

function fromEnvironment (env = process.env) {
  const raw = env && Object.hasOwn(env, KEY) ? String(env[KEY]).trim() : '';
  if (raw === '') return 0;
  if (!/^(0|[1-9][0-9]{0,5})$/.test(raw) || Number(raw) > 120000) throw new TypeError(KEY + ' must be an integer 0..120000');
  const ms = Number(raw);
  if (ms) console.warn('Evaluator completion delay control is on:', ms + ' ms before each durable completion (' + KEY + ')');
  return ms;
}
module.exports = { KEY, fromEnvironment };
