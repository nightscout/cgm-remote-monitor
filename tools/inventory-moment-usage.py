#!/usr/bin/env python3
"""Report lexical Moment references in tracked application/test/tool JavaScript.

This is an inventory aid, not an alias-aware call graph or proof of non-use.
Comments count; indirect aliases without a Moment token may not appear.
"""
import json
import re
import subprocess
from collections import Counter
from pathlib import Path

root = Path(__file__).resolve().parents[1]
paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
pattern = re.compile(r'\b(?:moment|defaultMoment)\b|\.tz\(')
files = []
for relative in paths:
    if not relative.endswith(('.js', '.cjs', '.mjs')):
        continue
    if relative.split('/')[0] not in {'lib', 'bundle', 'webpack', 'bin', 'tests', 'tools'}:
        continue
    lines = (root / relative).read_text().splitlines()
    hits = [{'line': n, 'text': line.strip()[:200]}
            for n, line in enumerate(lines, 1) if pattern.search(line)]
    if hits:
        files.append({'path': relative, 'references': hits})
lock = json.loads((root / 'package-lock.json').read_text())
report = {
    'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(),
    'scope': __doc__.strip(),
    'versions': {name: lock['packages']['node_modules/' + name]['version']
                 for name in ['moment', 'moment-timezone', 'moment-timezone-data-webpack-plugin']},
    'fileCountsByRoot': dict(sorted(Counter(f['path'].split('/')[0] for f in files).items())),
    'matchingFiles': len(files),
    'matchingLines': sum(len(f['references']) for f in files),
    'files': files
}
print(json.dumps(report, indent=2))
