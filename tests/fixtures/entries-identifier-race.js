'use strict';

const assert = require('node:assert/strict');
const { Collection } = require('mongodb');
const { setTimeout: delay } = require('node:timers/promises');
const writeIntent = require('../../lib/storage/write-intent');

// Observe actual route matches and actual inserts. The deployment fixture's
// Mongo environment is private, so compose its normal shipping intent factory
// explicitly to select the same resend policy as the tenant environments.
// No storage reply or duplicate-key failure is fabricated here.
module.exports = function entriesIdentifierRace (lab, backend, mode) {
  const state = { matches: [], inserts: 0, duplicateCodes: [] };
  const restores = [], releases = [];
  function watchFactory (col, makeStep) {
    const previous = col.intentFactory;
    restores.push(() => { col.intentFactory = previous; });
    col.intentFactory = () => {
      const step = makeStep();
      return { ...step, async match (intent) {
        const result = await step.match(intent);
        if (intent.op === 'create') state.matches.push(result);
        return result;
      } };
    };
  }
  if (backend === 'mongo') {
    watchFactory(lab.mongoCol, () => writeIntent.forCollectionIntent(lab.mongoCol.storage, 'entries', 'v3', {
      env: { write: { resend: mode } }
    }));
  } else {
    for (const worker of lab.workers) {
      const env = worker.environments.get(lab.A);
      const previousWrite = env.write;
      restores.push(() => { env.write = previousWrite; });
      env.write = Object.freeze({ resend: mode });
      const col = worker.collections.get(lab.A);
      const factory = col.intentFactory;
      watchFactory(col, () => factory());
    }
  }

  async function insert (go) {
    const index = state.inserts++;
    if (index < 2) await new Promise(resolve => { releases[index] = resolve; });
    try { return await go(); } catch (error) {
      state.duplicateCodes.push(error.code);
      throw error;
    }
  }
  if (backend === 'mongo') {
    const original = Collection.prototype.insertOne;
    Collection.prototype.insertOne = function observedInsert (...args) {
      return this.collectionName === lab.name ? insert(() => original.apply(this, args)) : original.apply(this, args);
    };
    restores.push(() => { Collection.prototype.insertOne = original; });
  } else {
    for (const worker of lab.workers) {
      const original = worker.connection.query;
      worker.connection.query = function observedInsert (text, ...args) {
        return typeof text === 'string' && text.startsWith('INSERT INTO "' + lab.name + '"."entries" ')
          ? insert(() => original.call(this, text, ...args)) : original.call(this, text, ...args);
      };
      restores.push(() => { worker.connection.query = original; });
    }
  }
  state.arrived = async count => {
    const deadline = Date.now() + 5000;
    while (state.inserts < count && Date.now() < deadline) await delay(5);
    assert.equal(state.inserts, count, 'both requests must reach real INSERTs before release');
    assert.equal(state.matches.length, count, 'each route must finish its actual identifying read');
    assert.ok(state.matches.every(result => result === null), 'both actual identifier matches must miss');
  };
  state.release = index => {
    assert.equal(typeof releases[index], 'function', 'the requested INSERT reached the barrier');
    releases[index]();
  };
  state.restore = () => {
    releases.forEach(release => release());
    restores.reverse().forEach(restore => restore());
  };
  return state;
};
