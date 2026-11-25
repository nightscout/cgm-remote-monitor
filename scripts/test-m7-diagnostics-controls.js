#!/usr/bin/env node
'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- Exact reviewed source is compiled only in an owned child preload; scratch alone is removed. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), target = path.join(root, 'lib/diagnostics/m7.js');
const source = fs.readFileSync(target, 'utf8'), native = process.argv.includes('--native');
const controls = [
  { name: 'physical-checkedout-zero', before: 'value.checkedout += total - idle;', after: 'value.checkedout += 0;',
    grep: native ? 'observes real held-pool' : 'separates held physical clients', symptom: '0 !== 1' },
  { name: 'held-outer-body-omitted', before: 'function delta (name, amount) {', after: "function delta (name, amount) { if (name === 'window.outer_bodies') return;",
    grep: native ? 'preserves stored results/errors' : 'separates held physical clients', symptom: native ? 'held response diagnostic snapshot did not become ready' : '0 !== 1' }
];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-m7-diagnostics-control-'));
try {
  for (const control of controls) {
    if (!source.includes(control.before)) throw new Error('Diagnostic control source mismatch');
    const preload = path.join(scratch, control.name + '.js');
    fs.writeFileSync(preload, "'use strict';\nconst Module=require('node:module'),path=require('node:path');\nconst filename=" + JSON.stringify(target) + ";\nconst loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));require.cache[filename]=loaded;\nloaded._compile(" + JSON.stringify(source.replace(control.before, control.after)) + ",filename);\n");
    const result = spawnSync(process.execPath, ['--require', preload, require.resolve('mocha/bin/mocha.js'), path.join(root, native ? 'tests/m7-diagnostics.integration.test.js' : 'tests/m7-diagnostics.test.js'),
      '--grep', control.grep, '--reporter', 'spec'], { encoding: 'utf8', timeout: 120000,
      env: { ...process.env, NS_M7_DIAGNOSTICS_DOCKER_TEST: native ? '1' : '0', NS_M7_DIAGNOSTICS_TEST_PRELOAD: preload } });
    const output = result.stdout + result.stderr; process.stdout.write(output);
    if (result.status !== 1 || !output.includes(control.symptom)) throw new Error('Diagnostic oracle did not discriminate ' + control.name);
    process.stdout.write('M7_DIAGNOSTICS_CONTROL ' + control.name + ' oracle went red: ' + control.symptom + '\n');
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
