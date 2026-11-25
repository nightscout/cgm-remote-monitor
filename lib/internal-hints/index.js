'use strict';

// Writer-driven hints: versioned internal contracts, one shared post-commit
// sender and the receiving handler (spike S3). Not wired into any write path.
module.exports = Object.freeze({
  contract: require('./contract'),
  sender: require('./sender'),
  receiver: require('./receiver'),
  targets: require('./targets')
});
