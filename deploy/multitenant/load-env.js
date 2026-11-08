'use strict';

// Each container receives only its own environment document. Never source it
// through a shell or print a connection string on startup failure.
const fs = require('node:fs');
const file = process.env.NS_ENV_FILE || '/run/ns-config/env.json';
try {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 1048576) throw new Error();
  const values = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error();
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0') ||
        ['NODE_OPTIONS', 'NODE_PATH', 'PATH', 'LD_PRELOAD', 'NS_ENV_FILE'].includes(key)) throw new Error();
  }
  Object.assign(process.env, values);
} catch {
  process.stderr.write('Private service environment is missing or invalid\n');
  process.exit(78);
}
