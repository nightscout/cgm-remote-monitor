'use strict';

// Addressed schema events keep their immediate availability fence. Construction
// may restart only after its specific admission guard was interrupted by a new
// schema generation, and only after that generation passed revalidation.
function create () {
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
    await Promise.all([...schemas]);
    if (lastFailure && lastFailure.epoch > since) throw lastFailure.error;
  }
  async function prepare (fn) {
    if (preparing) throw new Error('PGSTREAM_STARTUP_ALREADY_PREPARING');
    preparing = true;
    try {
      for (;;) {
        const entered = generation;
        await verified(entered);
        let result;
        try { result = await fn(); }
        catch (error) {
          if (!interruptions.has(error) || generation === entered) throw error;
          await verified(entered);
          continue;
        }
        await verified(entered);
        return result;
      }
    } finally { preparing = false; }
  }
  return Object.freeze({ schema, prepare, interrupted });
}
module.exports = { create };
