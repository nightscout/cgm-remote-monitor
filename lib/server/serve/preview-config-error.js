'use strict';

// Shared by dependency-free deployment sizing and the serving configuration
// parser. Reading pool limits before an image build must not load API handlers.
class PreviewConfigError extends Error {}
module.exports = { PreviewConfigError };
