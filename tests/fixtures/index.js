'use strict';

module.exports = {
  aaps: require('./aaps-single-doc'),
  loop: require('./loop-batch'),
  loopOverride: require('./loop-override'),
  trio: require('./trio-pipeline'),
  deduplication: require('./deduplication'),
  edgeCases: require('./edge-cases'),
  partialFailures: require('./partial-failures'),
  nightscoutkitProfiles: require('./nightscoutkit-profiles'),
  nightscoutkitDevicestatus: require('./nightscoutkit-devicestatus')
};
