'use strict';
// Control mutant for run.sh --control early-drop: rewrite a SCRATCH copy of
// transport.js so close() destroys every connection at shutdown start (the
// behaviour before graceful shutdown). Refuses to touch the worktree's source.
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(process.argv[2]);
if (file === path.resolve(__dirname, '../../../lib/server/internal-api/transport.js')) throw new Error('control must mutate a scratch copy');
const source = fs.readFileSync(file, 'utf8');
const marker = 'for (const socket of sockets) if (!active.has(socket)) socket.destroy();';
if (source.split(marker).length !== 2) throw new Error('control marker must match exactly once');
fs.writeFileSync(file, source.replace(marker, 'for (const socket of sockets) socket.destroy();'));
console.log('EARLY_DROP_CONTROL_APPLIED', file);
