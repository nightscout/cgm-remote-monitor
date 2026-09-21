"""Seven alternating fresh-process pairs per supplied Node executable."""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('baseline')
parser.add_argument('candidate')
parser.add_argument('output')
parser.add_argument('--node', action='append', required=True)
args = parser.parse_args()
probe = Path(__file__).with_suffix('.cjs')
rows = []
for node in args.node:
    for run in range(7):
        for label, root in [('baseline', args.baseline), ('candidate', args.candidate)]:
            result = subprocess.run([node, '--expose-gc', str(probe), root],
                                    check=True, text=True, capture_output=True, timeout=60)
            row = json.loads(result.stdout)
            row.update(run=run, label=label)
            rows.append(row)
Path(args.output).write_text(json.dumps(rows, indent=2) + '\n')
