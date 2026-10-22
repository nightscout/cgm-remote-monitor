'use strict';

const semver = require('semver');
const supported = require('../../package.json').engines.node;

// Keep npm installation and both server entry points on the same runtime policy.
module.exports = function checkRuntime () {
  if (!semver.satisfies(process.version, supported)) {
    console.error('ERROR: Node ' + process.version + ' is not supported. Nightscout requires Node ' + supported + '. Upgrade Node before starting Nightscout; Node 24 LTS is recommended.');
    process.exit(1);
  }
};
