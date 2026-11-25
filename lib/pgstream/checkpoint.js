'use strict';
// The JSONB work-v1 runtime is retired. Historical rows are recognized only by
// typed admission; callers must select the maintained typed contract explicitly.
function create (options) {
  if (options.typed !== true) throw new TypeError('EVALUATOR_CHECKPOINT_TYPED_REQUIRED');
  return require('./typed-checkpoint').create(options);
}
module.exports={create,KIND:require('./typed-checkpoint').KIND,WORK_COLUMNS:Object.freeze([...require('./work-state').COLUMNS,'notification_work_pending',...require('./completion-lag').COLUMNS])};
