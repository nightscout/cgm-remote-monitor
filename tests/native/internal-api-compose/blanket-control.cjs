'use strict';
// Control mutant for run.sh --control blanket-window: rewrite a SCRATCH copy of
// transport.js so a tenant-bearing request on any route runs in the first
// module's operation window (listener-wide policy). Refuses to touch the
// worktree's own source.
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(process.argv[2]);
if (file === path.resolve(__dirname, '../../../lib/server/internal-api/transport.js')) throw new Error('control must mutate a scratch copy');
const source = fs.readFileSync(file, 'utf8');
const a = '  const table = routeTable(modules, { maxBytes, timeoutMs });\n';
const b = '      if (route.lifetime) await route.lifetime.operationWindow.run(await route.lifetime.resolveTenant(body)';
if (source.split(a).length !== 2 || source.split(b).length !== 2) throw new Error('control markers must match exactly once');
fs.writeFileSync(file, source.replace(a, a + '  const blanket = [...table.values()].find(entry => entry.lifetime)?.lifetime;\n')
  .replace(b, "      const lifetime = route.lifetime || (typeof body.tenant === 'string' ? blanket : null);\n      if (lifetime) await lifetime.operationWindow.run(await lifetime.resolveTenant(body)"));
console.log('BLANKET_WINDOW_CONTROL_APPLIED', file);
