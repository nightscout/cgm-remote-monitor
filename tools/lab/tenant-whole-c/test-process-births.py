"""Pure collector regressions. No real process births, services or signals."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('whole_c_collector', Path(__file__).with_name('run.py'))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
live = {'pid': 501, 'startTicks': '123', 'uid': 1000, 'group': 501, 'state': 'S',
        'commandDigest': hashlib.sha256(b'node\0source-probe.js\0').hexdigest()}
zombie = {**live, 'state': 'Z', 'commandDigest': hashlib.sha256(b'').hexdigest()}

def samples(values):
    known, terminal = {}, []
    for value in values:
        collector.remember_birth(known, terminal, value)
    return known, terminal

known, terminal = samples([live, zombie])
assert known[(501, '123')] == live, 'LIVE_IDENTITY_MUST_SURVIVE_ZOMBIE'
assert terminal == [zombie]
checks = 1
for values in [[zombie], [live, {**zombie, 'state': 'S'}], [live, {**live, 'state': 'Z'}],
               [live, {**live, 'uid': 1001}], [live, {**live, 'group': 502}],
               [live, {**live, 'commandDigest': 'f' * 64}]]:
    try:
        samples(values)
    except AssertionError:
        checks += 1
    else:
        raise AssertionError('unpaired/incomplete/changed identity must refuse')
known, _ = samples([live, {**live, 'startTicks': '124'}])
assert len(known) == 2 and known[(501, '123')] == live
checks += 1
mutable = dict(live)
known, _ = samples([mutable])
mutable['commandDigest'] = 'f' * 64
assert known[(501, '123')] == live
checks += 1
known, _ = samples([live, live, zombie])
assert len(known) == 1 and known[(501, '123')] == live
checks += 1
print(json.dumps({'sourceBirthControls': checks, 'scope': 'pure samples only; no services/processes/signals'}))
