import argparse
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess

parser = argparse.ArgumentParser(description='Compare notification-cache retention and sampled allocations using a disposable MongoDB database.')
parser.add_argument('baseline')
parser.add_argument('candidate')
parser.add_argument('output')
parser.add_argument('--node', default=shutil.which('node'))
parser.add_argument('--mongo-uri', required=True)
parser.add_argument('--port', default='17341')
args = parser.parse_args()
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
roots = {'baseline': str(Path(args.baseline).resolve()), 'candidate': str(Path(args.candidate).resolve())}
probe = Path(__file__).with_name('notification-cache-probe.cjs')
results = []
for run in range(7):
    for mode in ('no-receipt', 'receipt'):
        for label, root in roots.items():
            env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG') if key in os.environ}
            env.update(API_SECRET='benchmark-fixture-secret', MONGODB_URI=args.mongo_uri, PORT=args.port,
                       HOSTNAME='127.0.0.1', NODE_ENV='production', INSECURE_USE_HTTP='true', ENABLE='careportal',
                       MONGO_POOL_SIZE='5', MONGO_MIN_POOL_SIZE='1')
            process = subprocess.run([args.node, '--expose-gc', str(probe), root, mode, str(out / f'{run}-{label}-{mode}.allocations.json')], env=env,
                                     text=True, capture_output=True, timeout=60)
            (out / f'{run}-{label}-{mode}.log').write_text(process.stdout + process.stderr)
            if process.returncode:
                raise RuntimeError((process.stdout + process.stderr)[-2000:])
            data = json.loads(next(line.removeprefix('PROBE_RESULT ') for line in process.stdout.splitlines()
                                   if line.startswith('PROBE_RESULT ')))
            assert data['sends'] == 100 and data['duplicates'] == 500 and data['recentEntries'] == 100
            assert data['receiptEntries'] == (100 if mode == 'receipt' else 0)
            assert data['recentTypes'] == (['object'] if label == 'baseline' else ['boolean'])
            data.update(run=run, label=label)
            results.append(data)
            (out / 'results.json').write_text(json.dumps(results, indent=2))
            print(run, mode, label, data['retainedGrowth'], data['sampledAllocationBytes'], flush=True)
for mode in ('no-receipt', 'receipt'):
    for label in roots:
        rows = [row for row in results if row['mode'] == mode and row['label'] == label]
        print(mode, label, {key: {'median': statistics.median(row[key] for row in rows),
                                  'min': min(row[key] for row in rows), 'max': max(row[key] for row in rows)}
                            for key in ('retainedGrowth', 'sampledAllocationBytes', 'workloadMs')})
