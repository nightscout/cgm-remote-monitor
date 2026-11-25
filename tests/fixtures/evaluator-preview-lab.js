'use strict';

// Product evaluator fixtures use one registry/trusted-metadata/pgstream setup.
// The historical import path is retained for caller compatibility; it does not
// enable static tenant files or a parallel discovery transport.
module.exports = require('./evaluator-preview-registry-lab');
