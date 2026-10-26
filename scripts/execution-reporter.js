'use strict';

const path = require('node:path');
const {reporters} = require('mocha');
const root = path.resolve(__dirname, '..');
const support = new Set(['tests/00_production-safety.test.js', 'tests/XX_clean.test.js']);

// Mocha's --fail-zero counts pending tests and support tests. Track completed
// test bodies per selected file, including events relayed from parallel workers.
// This complements, rather than replaces, the reporter's normal failure count.
class ExecutionReporter extends reporters.Spec {
  constructor(runner, options) {
    super(runner, options);
    const expected = new Set((options.files || []).map(file => path.resolve(file)));
    const executed = new Set();
    runner.on('pass', test => { if (test.file) executed.add(path.resolve(test.file)); });
    runner.on('fail', test => { if (test.type === 'test' && test.file) executed.add(path.resolve(test.file)); });
    this.done = (failures, done) => {
      let missing = 0, intended = 0;
      for (const file of expected) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (support.has(relative)) continue;
        // This probe uses POSIX signals and intentionally skips Windows.
        if (process.platform === 'win32' && relative === 'tests/development-watch.test.js') {
          console.error('TEST_EXECUTION: unsupported on Windows: ' + relative);
          continue;
        }
        intended++;
        if (!executed.has(file)) {
          console.error('TEST_EXECUTION: no test body completed in ' + relative);
          missing++;
        }
      }
      if (!intended) {
        console.error('TEST_EXECUTION: no intended test files (support tests do not count)');
        missing++;
      }
      done(failures + missing);
    };
  }
}
module.exports = ExecutionReporter;
