#!/usr/bin/env node
'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- Read exact source paths into uniquely owned scratch; delete only that scratch. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-proof-control-'));
try {
  for (const file of ['lib/tenant-authorization/access-token.js', 'lib/tenant-authorization/signature-proof.js', 'tests/access-signature-proof.test.js']) {
    fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true }); fs.copyFileSync(path.join(root, file), path.join(scratch, file));
  }
  const target = path.join(scratch, 'lib/tenant-authorization/signature-proof.js'), source = fs.readFileSync(target, 'utf8');
  const begin = source.indexOf('  const key = crypto.getFips()'), end = source.indexOf("signature.toString('base64');", begin);
  if (begin < 0 || end < 0 || !source.includes('MAX_PROOFS = 256') || !source.includes('MAX_PROOF_BYTES = 1048576')) throw new Error('Proof control source mismatch');
  const controls = [
    { name: 'constant-proof-key', grep: 'changed signed bytes', symptom: 'Missing expected exception', changed:
      source.slice(0, begin) + "  const key = 'deliberate-shared-proof-control';" + source.slice(end + "signature.toString('base64');".length) },
    { name: 'entry-bound-removed', grep: 'one process bound', symptom: '257 !== 258', changed: source.replace('MAX_PROOFS = 256', 'MAX_PROOFS = 4096') },
    { name: 'encoded-byte-bound-removed', grep: 'encoded proof byte budget', symptom: '140 !== 141', changed: source.replace('MAX_PROOF_BYTES = 1048576', 'MAX_PROOF_BYTES = 104857600') }
  ];
  for (const control of controls) {
    fs.writeFileSync(target, control.changed);
    const result = spawnSync(process.execPath, [require.resolve('mocha/bin/mocha.js'), path.join(scratch, 'tests/access-signature-proof.test.js'),
      '--grep', control.grep, '--reporter', 'spec'], { encoding: 'utf8' });
    const output = result.stdout + result.stderr; process.stdout.write(output);
    if (result.status !== 1 || !output.includes(control.symptom)) throw new Error('Proof oracle did not discriminate ' + control.name);
    process.stdout.write('SIGNATURE_PROOF_CONTROL ' + control.name + ' expected assertion went red: ' + control.symptom + '\n');
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
