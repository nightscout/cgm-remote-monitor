'use strict';
// stdin -> stdout, replacing every value listed in the JSON file given as argv[2]
// plus token/URL/JWT patterns. Used by run.sh for the captured service logs.
const fs = require('node:fs');
const secrets = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let text = fs.readFileSync(0, 'utf8');
for (const value of secrets) if (value && value.length >= 8) text = text.split(value).join('[REDACTED]');
text = text.replace(/hvs\.[A-Za-z0-9_-]{20,}/g, '[REDACTED-VAULT-TOKEN]').replace(/(postgres(?:ql)?:\/\/)[^@\s"']+@/g, '$1[REDACTED]@')
  .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED-JWT]').replace(/PASSWORD '[^']*'/g, "PASSWORD '[REDACTED]'");
process.stdout.write(text);
