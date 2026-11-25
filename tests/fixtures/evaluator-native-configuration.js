'use strict';

// Normal starts use the CLI's environment loader. The fixture can also start
// the same role with a bounded acquisition window or a controlled timer.
module.exports = function configure (input, source) {
  if (!input) return require('../../lib/cli/commands/multitenant').configure(['evaluator'], source);
  const parser = require('../../lib/server/serve/evaluator-config');
  const internal = require('../../lib/server/internal-api/listener-config').resolve(['evaluator'], source);
  const operationConfig = require('../../lib/server/serve/operation-cohort-config').load(source);
  const evaluatorPreview = { ...parser.parse(JSON.parse(input), source, internal), inspection: parser.inspectionFor(source) };
  return { internal, operationConfig, evaluatorPreview };
};
