'use strict';
const fs = require('node:fs'), d = require('../../lib/diagnostics/m7');
d.configureRoles(['api']);
const result = () => fs.writeSync(2, JSON.stringify({ clinicalResult: 'unchanged', enabled: d.enabled, logging: d.snapshot().logging || null }) + '\n');
if (process.argv[2] === 'unref') { d.emit(); result(); }
else if (process.argv[2] === 'after-close') { d.emit(); setTimeout(() => { d.close(); setTimeout(() => { fs.writeSync(1, 'APPLICATION_STDOUT_UNCHANGED\n'); result(); }, 100); }, 100); }
else process.stdin.once('data', () => {
  if (process.argv[2] === 'pressure') {
    process.stdout.write(Buffer.alloc(1048576, 120));
    for (let i = 0; i < 20; i++) d.emit();
    result(); d.close(); process.stdin.destroy();
  } else if (process.argv[2] === 'closed-reader') {
    d.emit(); setTimeout(() => { result(); d.close(); process.stdin.destroy(); }, 200);
  } else throw new Error('Owned diagnostic output mode required');
});
