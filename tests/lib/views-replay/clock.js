'use strict';

// A pinned wall clock for the replay. Every Date.now() and every `new Date()`
// with no arguments answers the replay instant, so the cache's retention
// (lib/server/cache.js), the loader's lastUpdated (lib/data/dataloader.js),
// the sandbox's time, moment() and the notification service's ack times all
// read the minute being replayed. Dates built from an argument are untouched.
//
// The MongoDB driver measures its own timeouts with process time
// (mongodb/lib/utils.js processTimeMS), not Date, so pinning Date does not
// reach it.

const RealDate = Date;
let pinned = null;

function PinnedDate (...args) {
  if (!new.target) return new RealDate(pinned === null ? RealDate.now() : pinned).toString();
  return args.length ? new RealDate(...args) : new RealDate(pinned === null ? RealDate.now() : pinned);
}
PinnedDate.prototype = RealDate.prototype;
PinnedDate.now = function now () { return pinned === null ? RealDate.now() : pinned; };
PinnedDate.parse = RealDate.parse;
PinnedDate.UTC = RealDate.UTC;

function install () { global.Date = PinnedDate; }
function uninstall () { global.Date = RealDate; pinned = null; }
function pin (ms) { pinned = ms; }

module.exports = { install, uninstall, pin, RealDate };
