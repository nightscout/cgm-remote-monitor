#!/usr/bin/env python3
"""Print a bounded lexical inventory, not an alias-aware call graph."""
import hashlib
import json
import pathlib
import re
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
patterns = {
    'ui_widget': re.compile(r'\.(?:accordion|autocomplete|button|checkboxradio|controlgroup|datepicker|dialog|draggable|droppable|menu|progressbar|resizable|selectable|selectmenu|slider|sortable|spinner|tabs|tooltip)\s*\('),
    'ui_global': re.compile(r'\$\.ui\b|jQuery\.ui\b'),
    'flot': re.compile(r'\$\.plot\b|plothover|plotclick'),
    'ui_stylesheet': re.compile(r'jquery-ui(?:\.min)?\.css'),
    'package_import': re.compile(r'require\([\'\"](?:jquery(?:-ui-bundle|\.tooltips)?|flot)(?:/[\w.\-/]+)?[\'\"]\)'),
}
files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
records = []
for name in files:
    if not name.startswith(('lib/', 'bundle/', 'static/report/js/', 'views/')) or not name.endswith(('.js', '.ejs', '.html')):
        continue
    source = (root / name).read_text()
    hits = []
    for number, line in enumerate(source.splitlines(), 1):
        kinds = [kind for kind, pattern in patterns.items() if pattern.search(line)]
        if kinds:
            hits.append({'line': number, 'kinds': kinds, 'text': line.strip()})
    if hits:
        records.append({'path': name, 'sha256': hashlib.sha256(source.encode()).hexdigest(), 'hits': hits})
lock = json.loads((root / 'package-lock.json').read_text())['packages']
print(json.dumps({
    'baseline': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
    'scope': 'Tracked JS/EJS/HTML under lib, bundle, static/report/js and views. Lexical matches include comments and omit dynamic/aliased calls; review the source before treating a match as a consumer.',
    'installedVersions': {name: lock['node_modules/' + name]['version'] for name in ['jquery', 'jquery-ui-bundle', 'jquery.tooltips', 'flot']},
    'files': records,
}, indent=2))
