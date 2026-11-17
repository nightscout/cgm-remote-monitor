'use strict';

// Delay one selected real storage query either before dispatch or after its
// callback has received Mongo rows. Never replace those rows with a fixture.
module.exports = function readBarrier (store, matches, phase = 'after') {
  const original = store.list;
  let enter;
  let pending;
  let claimed = false;
  let released = false;
  const entered = new Promise(resolve => { enter = resolve; });
  const observed = [];

  function record (error, docs) {
    observed.push({ error: error && error.message, documents: (docs || []).map(doc => ({
      identifier: doc.identifier, generation: doc.frameGeneration, sgv: doc.sgv, carbs: doc.carbs
    })) });
  }

  function list (query, callback) {
    if (claimed || !matches(query)) return original.call(store, query, callback);
    claimed = true;
    if (phase === 'before') {
      pending = () => original.call(store, query, (error, docs) => {
        record(error, docs);
        callback(error, docs);
      });
      enter();
    } else {
      original.call(store, query, (error, docs) => {
        record(error, docs);
        pending = override => callback(override || error, override ? undefined : docs);
        enter();
      });
    }
  }
  store.list = list;

  function release (error) {
    if (!pending || released) return;
    released = true;
    pending(error);
  }

  return {
    entered,
    observed,
    release,
    restore () {
      if (store.list === list) store.list = original;
      release();
    }
  };
};
