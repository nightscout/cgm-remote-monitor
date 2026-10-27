"""Compare real report fixture timings in seven alternating browser processes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('baseline')
parser.add_argument('candidate')
parser.add_argument('output')
parser.add_argument('--node', required=True)
args = parser.parse_args()
candidate = Path(args.candidate).resolve()
rows = []
for run in range(7):
    for label, root in [('baseline', Path(args.baseline).resolve()), ('candidate', candidate)]:
        env = {key: value for key, value in os.environ.items() if not key.startswith('NIGHTSCOUT_REPORT_')}
        env['NIGHTSCOUT_REPORT_REFERENCE_ROOT'] = str(root)
        env['NIGHTSCOUT_TEST_BROWSER'] = 'chromium'
        result = subprocess.run([args.node, 'node_modules/mocha/bin/mocha.js', '--require', './tests/browser/hooks.js',
                                 'tests/browser/legacy-reports.test.js', '--grep', 'preserves plotted'],
                                cwd=candidate, env=env, text=True, capture_output=True, timeout=120)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        elapsed = [int(value) for value in re.findall(r'Report idle after (\d+) ms', result.stdout)]
        assert len(elapsed) == 4
        rows.append({'run': run, 'label': label, 'reportFixtureMs': elapsed,
                     'browser': re.search(r'Browser fixture: (.+)', result.stdout).group(1),
                     'gitHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()})
evidence = {'scope': 'Fixture HTTP loading plus report rendering; not CPU-only or production latency',
            'node': subprocess.check_output([args.node, '--version'], text=True).strip(),
            'sources': {name: hashlib.sha256((candidate / name).read_bytes()).hexdigest() for name in [
                'tools/audits/report-flot-comparison.py', 'tests/browser/legacy-reports.test.js',
                'bundle/bundle.reports.source.js', 'lib/report_plugins/loopalyzer.js',
                'lib/report_plugins/hourlystats.js', 'lib/report_plugins/percentile.js', 'static/css/report.css']},
            'samples': rows}
Path(args.output).write_text(json.dumps(evidence, indent=2) + '\n')
