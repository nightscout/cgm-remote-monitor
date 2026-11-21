'use strict';

// Compatibility for callers selecting a tenant scope by its original module name.
const scope = require('./generation-scope');
module.exports = { ...scope, isWindow: value => scope.isScope(value) && !value.closed };
