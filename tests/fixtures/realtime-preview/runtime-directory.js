'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
module.exports = function runtimeDirectory ({ captureDir, phaseId }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-rt-')); fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory), owned = { path: directory, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o777,
    pid: process.pid, phaseId, captureDir: path.resolve(captureDir) };
  const record = extra => fs.writeFileSync(path.join(captureDir, 'consumer-runtime-directory.json'), JSON.stringify({ ...owned, ...extra }, null, 2) + '\n');
  record({ state: 'created' });
  return Object.freeze({ path: directory,
    close () {
      const current = fs.lstatSync(directory);
      assert(current.isDirectory() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino && current.uid === owned.uid,
        'RT_RUNTIME_DIRECTORY_OWNERSHIP_CHANGED');
      assert.equal(fs.readdirSync(directory).length, 0, 'RT_RUNTIME_DIRECTORY_NONEMPTY no unknown entry may be removed');
      fs.rmdirSync(directory); record({ state: 'closed', absent: !fs.existsSync(directory) });
    }
  });
};
