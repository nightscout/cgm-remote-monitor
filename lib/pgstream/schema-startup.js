'use strict';

// Addressed schema events keep their immediate availability fence. Construction
// may restart only after its specific admission guard was interrupted by a new
// schema generation, and only after that generation passed revalidation.
function create ({ isPendingVerification = () => false } = {}) {
  const schemas = new Set(), interruptions = new WeakSet();
  let generation = 0, preparing = false, lastFailure;
  function interrupted (message) {
    const error = new Error(message); interruptions.add(error); return error;
  }
  function schema (fn) {
    const epoch = ++generation;
    const task = (async () => fn())();
    schemas.add(task);
    task.then(() => schemas.delete(task), error => {
      schemas.delete(task); lastFailure = { epoch, error };
    });
    return task;
  }
  async function verified (since) {
    for (;;) {
      const observed = generation;
      await Promise.all([...schemas]);
      if (lastFailure && lastFailure.epoch > since) throw lastFailure.error;
      // Settling one addressed event can register another. Join that actual
      // work before declaring the schema cut stable; no timer discovers it.
      if (!schemas.size && generation === observed) return observed;
    }
  }
  async function prepare (fn) {
    if (preparing) throw new Error('PGSTREAM_STARTUP_ALREADY_PREPARING');
    preparing = true;
    try {
      for (;;) {
        let entered;
        do { entered = await verified(generation); }
        while (schemas.size || entered !== generation);
        let result;
        try { result = await fn(); }
        catch (error) {
          // A physical backend can also refuse an acquisition while its own
          // operation window is being verified by an overlapping schema event.
          if (generation === entered || !(interruptions.has(error) || isPendingVerification(error))) throw error;
          await verified(entered);
          continue;
        }
        let completed;
        do { completed = await verified(entered); }
        while (schemas.size || completed !== generation);
        return result;
      }
    } finally { preparing = false; }
  }
  return Object.freeze({ schema, prepare, interrupted });
}
module.exports = { create };
