#!/usr/bin/env python3
"""Known-bad source controls; restore exact owned bytes after every mutation."""
import json, os, pathlib, subprocess
root = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path(os.environ.get('TRUSTED_WORKER_CONTROLS_OUT', '/tmp/trusted-worker-controls-20261113'))
out.mkdir(parents=True, exist_ok=True)
node = os.environ.get('TRUSTED_WORKER_NODE', '/home/bewest/n/n/versions/node/24.22.1/bin/node')
cases = [
 ('settings-cache', 'lib/trusted-worker/postgres.js', 'if (!force && row && hit &&', 'if (false && !force && row && hit &&', 'TRUSTED_UNCHANGED_ZERO_SQL'),
 ('operational-scope', 'lib/trusted-worker/lifecycle.js', 'context.runInAsyncScope(async () => {', '(async () => {', 'TRUSTED_OPERATIONAL_OUTSIDE_TENANT'),
 ('recovery-generation', 'lib/trusted-worker/postgres.js', 'function invalidate () { generation++;', 'function invalidate () {', 'Missing expected rejection'),
 ('runtime-settings', 'lib/server/serve/evaluator-runtime.js', 'const unchangedSettings = readMetadata &&', 'const unchangedSettings = false && readMetadata &&', 'TRUSTED_RUNTIME_UNCHANGED_SETTINGS'),
 ('checkpoint-compare', 'lib/server/serve/evaluator-runtime.js', 'if (same(state.processed, validSignature(seen)))', 'if (state.processed)', 'TRUSTED_WRITE_DURING_EVALUATION_RETAINED'),
 ('verify-generation', 'lib/trusted-worker/postgres.js', 'if (closed || generation !== verifyingGeneration) throw failure();', 'if (closed) throw failure();', 'Missing expected rejection'),
 ('settings-version-race', 'lib/trusted-worker/postgres.js', ' || readingRevision !== revisions.get(tenant)', '', 'Missing expected rejection'),
 ('publication-epoch', 'lib/server/serve/evaluator-runtime.js', "if (!current.available || current.generation !== epoch.generation) throw new Error('TRUSTED_WORKER_UNAVAILABLE');", "if (false) throw new Error('TRUSTED_WORKER_UNAVAILABLE');", 'TRUSTED_INFLIGHT_REVISION_NOT_PUBLISHED'),
 ('realtime-recovery-generation', 'lib/server/realtime/runtime.js', 'if (workerState && !workerReady(cell)) return epoch().available && !!seen?.get(tenant) && seen.get(tenant).identity !== null;', '', 'TRUSTED_RT_RECOVERY_REACQUIRES'),
 ('protocol-fanout-epoch', 'lib/server/realtime/protocol.js', 'const assertFanout = () => assertCurrent?.();', 'const assertFanout = () => {};', 'TRUSTED_PROTOCOL_NO_STALE_EMISSION')
]
results = []
for label, relative, old, new, symptom in cases:
 p = root / relative; original = p.read_bytes(); text = original.decode()
 assert text.count(old) == 1, (label, 'source mismatch')
 if label == 'operational-scope':
  mutant = text.replace(old, new).replace('await reader.verify(); last = now();\n    }).finally', 'await reader.verify(); last = now();\n    })().finally')
 else: mutant = text.replace(old, new)
 try:
  p.write_text(mutant)
  result = subprocess.run([node, 'node_modules/mocha/bin/mocha.js', '--timeout', '10000', 'tests/trusted-worker.test.js'], cwd=root, env=dict(os.environ, NODE_ENV='test'), capture_output=True, text=True, timeout=30)
  (out / (label + '.log')).write_text(result.stdout + result.stderr)
  assert result.returncode != 0 and symptom in result.stdout + result.stderr, (label, result.returncode, result.stdout + result.stderr)
  results.append({'control': label, 'exit': result.returncode, 'symptom': symptom})
 finally: p.write_bytes(original)
result = subprocess.run([node, 'node_modules/mocha/bin/mocha.js', '--timeout', '10000', 'tests/trusted-worker.test.js'], cwd=root, env=dict(os.environ, NODE_ENV='test'), capture_output=True, text=True, timeout=30)
(out / 'restored.log').write_text(result.stdout + result.stderr)
assert result.returncode == 0, result.stdout + result.stderr
(out / 'summary.json').write_text(json.dumps({'controls': results, 'restoredExit': result.returncode}, indent=2) + '\n')
print(json.dumps({'redControls': len(results), 'restoredExit': result.returncode}))
