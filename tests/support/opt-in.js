'use strict';

const MARK = '[pending opt-in: ';

// Disabled labs still register their tests, without opening their databases or
// containers. Enabled labs must complete test bodies like any ordinary suite.
function optInSuite (enabled, requirement) {
  if (typeof requirement !== 'string' || !requirement.trim()) {
    throw new TypeError('optInSuite needs its enabling requirement');
  }
  return function (title, body) {
    return enabled ? describe(title, body) : describe.skip(title + ' ' + MARK + requirement + ']', body);
  };
}

function isOptInPending (test) {
  return typeof test.fullTitle === 'function' && test.fullTitle().includes(MARK);
}

module.exports = { optInSuite, isOptInPending };
