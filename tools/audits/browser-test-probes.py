"""Compare the migrated bundle/Socket.IO assertions on Unix; not server memory."""
import argparse
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('baseline', help='Built checkout retaining the old jsdom tests')
parser.add_argument('candidate', help='Built checkout containing the browser tests')
parser.add_argument('output')
parser.add_argument('--node', default=shutil.which('node'))
parser.add_argument('--browsers', nargs='+', choices=['chromium', 'firefox', 'webkit'], default=['chromium', 'webkit'])
args = parser.parse_args()
if not args.node:
    parser.error('Provide --node')
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
rows = []
for run in range(7):
    for label in ['jsdom'] + args.browsers:
        root = Path(args.baseline if label == 'jsdom' else args.candidate).resolve()
        command = [args.node, 'node_modules/mocha/bin/mocha.js', '--timeout', '30000']
        if label == 'jsdom':
            command += ['--exit', 'tests/bundle.smoke.test.js', 'tests/dependency-socket-parser.test.js',
                        '--grep', 'Bundle smoke|served browser']
        else:
            command += ['--require', './tests/browser/hooks.js', 'tests/browser/bundle.test.js',
                        'tests/browser/socket-client.test.js']
        env = {key: os.environ[key] for key in ['PATH', 'HOME', 'TMPDIR', 'LANG'] if key in os.environ}
        env['NIGHTSCOUT_TEST_BROWSER'] = label
        started = time.monotonic()
        peak = 0
        log_path = out / f'{run}-{label}.log'
        with log_path.open('w') as log:
            process = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
            while process.poll() is None:
                listing = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss='], text=True)
                processes = [tuple(map(int, line.split())) for line in listing.splitlines() if len(line.split()) == 3]
                owned = {process.pid}
                while True:
                    expanded = owned | {pid for pid, parent, rss in processes if parent in owned}
                    if expanded == owned:
                        break
                    owned = expanded
                peak = max(peak, sum(rss for pid, parent, rss in processes if pid in owned) * 1024)
                time.sleep(0.025)
        if process.returncode:
            raise RuntimeError(f'{label} run {run} failed: {log_path.read_text()}')
        row = dict(run=run, label=label, elapsedSeconds=time.monotonic() - started, peakProcessTreeRss=peak)
        rows.append(row)
        (out / 'results.json').write_text(json.dumps(rows, indent=2) + '\n')
        print(row, flush=True)
for label in ['jsdom'] + args.browsers:
    group = [row for row in rows if row['label'] == label]
    print(label, {key: [statistics.median(row[key] for row in group), min(row[key] for row in group),
                       max(row[key] for row in group)] for key in ['elapsedSeconds', 'peakProcessTreeRss']})
