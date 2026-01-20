'use strict';

module.exports = {
  aaps: require('./aaps-single-doc'),
  loop: require('./loop-batch'),
  trio: require('./trio-pipeline'),
  deduplication: require('./deduplication'),
  edgeCases: require('./edge-cases'),
  partialFailures: require('./partial-failures')
};
