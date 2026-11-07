#!/usr/bin/env python3
"""Source check or explicitly granted SQL-core campaign on parent-owned PG.
Never creates/pulls/deletes containers. --grant records authorization, not a slot.
"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tarfile
import time
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OLD = 'a7f5cbf71ab9016855976fae74730727d0a78024'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

def git(worktree, *args):
    return subprocess.check_output(['git', '-C', str(worktree), *args])

def extract(archive, target):
    target.mkdir(mode=0o700)
    with tarfile.open(archive) as source:
        source.extractall(target, filter='data')

def source_check(worktree):
    for path in HERE.glob('*.py'):
        ast.parse(path.read_text(), filename=str(path))
    for path in HERE.glob('*.js'):
        subprocess.run(['node', '--check', str(path)], check=True, capture_output=True)
    controls = json.loads((HERE / 'controls.json').read_text())
    for control in controls:
        if 'path' in control:
            data = (worktree / control['path']).read_text()
            assert data.count(control['before']) == 1, control['id']
            with tempfile.TemporaryDirectory(prefix='whole-c-source-control-') as directory:
                mutant = Path(directory) / 'mutant.js'
                mutant.write_text(data.replace(control['before'], control['after']))
                subprocess.run(['node', '--check', str(mutant)], check=True, capture_output=True)
        else:
            candidate = json.loads((worktree / control['candidate']).read_text())
            assert all(candidate['migrations'][1]['up'].count(sql) == 1 for sql in control['remove'])
    print(json.dumps({'sourceSyntax': 'pass', 'controlSignatures': len(controls), 'native': 'UNMEASURED'}))

def proc(pid):
    try:
        raw = Path('/proc', str(pid), 'stat').read_text()
        fields = raw[raw.rfind(')') + 2:].split()
        return {'pid': pid, 'state': fields[0], 'group': int(fields[2]), 'startTicks': fields[19],
                'uid': Path('/proc', str(pid)).stat().st_uid,
                'commandDigest': digest(Path('/proc', str(pid), 'cmdline').read_bytes())}
    except (FileNotFoundError, ProcessLookupError):
        return None

def group_births(group):
    result = []
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit():
            continue
        value = proc(int(directory.name))
        if value and value['group'] == group:
            result.append(value)
    return result

def parent_resource(config):
    expected = config['parentResource']
    # Never save Config.Env or a full inspect: it contains fixture credentials.
    actual = json.loads(subprocess.check_output(['docker', 'inspect', expected['containerId']]))[0]
    assert actual['Id'] == expected['containerId'] and actual['Image'] == expected['image']
    assert actual['Config']['Labels'].get(expected['labelKey']) == expected['owner']
    assert actual['State']['Running']
    ports = actual['NetworkSettings']['Ports']['5432/tcp']
    assert any(p['HostIp'] == '127.0.0.1' and int(p['HostPort']) == config['expectedEndpoint']['port'] for p in ports)
    mounts = sorted(m['Name'] for m in actual['Mounts'] if m['Type'] == 'volume')
    assert mounts == sorted(expected['volumes'])
    return {'containerId': actual['Id'], 'image': actual['Image'], 'volumes': mounts, 'owner': expected['owner'], 'retainedByParent': True}

def inventory():
    return {key: sorted(subprocess.check_output(command, text=True).splitlines()) for key, command in {
        'containers': ['docker', 'ps', '-aq'], 'volumes': ['docker', 'volume', 'ls', '-q'], 'networks': ['docker', 'network', 'ls', '-q']}.items()}

def physical_control(control, events):
    by_phase = lambda phase: [event['value'] for event in events if event['phase'] == phase]
    cid = control['id']
    if cid == 'second-checkpoint-loss':
        before = by_phase('C1-source-before-verdict')[-1]['evaluator_checkpoint.tenant_consumer_checkpoint']['rows']
        after = by_phase('C1-independent-artifact-before-verdict')[-1]['files']['evaluator_checkpoint.tenant_consumer_checkpoint']['rows']
        return len(before) > 0 and len(after) == 0
    if cid == 'skip-identity-sequence':
        return any(int(row['next']) <= int(row['max']) for row in by_phase('actual-writer-next-identity'))
    if cid == 'realtime-write-broadening':
        return any(row['roleClass'] == 'realtime' and row['code'] is None and row['count'] > 0 for row in by_phase('actual-role-statement'))
    if cid == 'tampered-digest-bypass':
        categories = by_phase('C2-tamper-actual-statements-before-verdict')[-1]
        physical = by_phase('C2-tamper-physical-before-verdict')[-1]
        completed = by_phase('C2-tamper-completed-SQL-before-verdict')[-1]
        return 'INSERT' in categories and any(row['command'] == 'INSERT' and row['rowCount'] > 0 for row in completed) and not any(table['rows'] for table in physical.values())
    if cid == 'commit-interrupted-restore':
        return any(table['rows'] for table in by_phase('C2-interrupted-before-verdict')[-1].values())
    if cid == 'profile-populated-guard':
        value = by_phase('C4-guard-after-before-verdict-profile-true')[-1]['profile.profile']
        return len(value['ledger']) == 2 and any(col['attname'] == 'insertion_ordinal' for col in value['columns']) and len(value['rows']) > 0
    if cid == 'running-writer-window':
        proof = by_phase('C5-live-writer-physical-before-verdict')[-1]
        observation = by_phase('C5-live-writer-observation')[-1]
        return proof['proof']['quiesced'] and any(row['current'] and row['current']['state'] not in ['T', 't', 'Z'] for row in observation) and any(int(row['last_stamp']) > 1000 for row in proof['clock'])
    raise AssertionError('unknown control')

def campaign(args):
    os.umask(0o077)
    worktree, out, deps = args.worktree.resolve(), args.out.resolve(), args.deps.resolve()
    assert args.grant and not out.exists()
    assert git(worktree, 'status', '--porcelain').strip() == b'', 'source must be committed and clean'
    head = git(worktree, 'rev-parse', 'HEAD').decode().strip()
    for local in HERE.iterdir():
        if local.is_file():
            assert local.read_bytes() == (worktree / 'tools/lab/tenant-whole-c' / local.name).read_bytes(), 'instrument/worktree mismatch'
    config = json.loads(args.config.read_text())
    assert config['grant'] == args.grant and config['sourceHead'] == head
    role_bytes = Path(config['actualRoleManifestPath']).read_bytes()
    assert digest(role_bytes) == config['actualRoleManifestSha256']
    assert json.loads(role_bytes)['grants'] == config['acl']
    assert (deps / '.codex-source-package-lock.json').read_bytes() == (worktree / 'package-lock.json').read_bytes()
    out.mkdir(mode=0o700)
    before = inventory(); write(out / 'inventory-before.json', before)
    write(out / 'parent-resource-before.json', parent_resource(config))
    archives = {}
    for name, commit in [('source', head), ('old', OLD)]:
        archive = out / (name + '.tar')
        with archive.open('wb') as handle:
            subprocess.run(['git', '-C', str(worktree), 'archive', commit], stdout=handle, check=True)
        archives[name] = {'head': commit, 'sha256': digest(archive.read_bytes())}
    extract(out / 'old.tar', out / 'old-source')
    write(out / 'old-source' / 'whole-c-source.json', {'head': OLD})
    assert (out / 'old-source' / 'package-lock.json').read_bytes() == (deps / '.codex-source-package-lock.json').read_bytes()
    write(out / 'source-index.json', archives)
    controls = json.loads((HERE / 'controls.json').read_text())
    sequence = []
    if args.stages in ['initial', 'all']:
        sequence.append(('initial', 'all', None, False))
    if args.stages in ['controls', 'all']:
        for control in controls:
            sequence.extend([(control['id'] + '-red', control['phase'], control, True), (control['id'] + '-restored', control['phase'], None, False)])
    if args.stages in ['final', 'all']:
        sequence.append(('final', 'all', None, False))
    summary = []
    try:
        for label, phase, control, red in sequence:
            capture = out / label; capture.mkdir(mode=0o700)
            source = capture / 'source'; extract(out / 'source.tar', source)
            write(source / 'whole-c-source.json', {'head': head})
            current = {**config, 'oldRoot': str(out / 'old-source'), 'oldHead': OLD,
                       'captureDirectory': str(capture), 'prefix': 'wc_' + os.urandom(6).hex(),
                       'actualRoleManifestPath': str(capture / 'actual-role-manifest.json')}
            (capture / 'actual-role-manifest.json').write_bytes(role_bytes)
            if control:
                current['controlName'] = control['id']
                if 'path' in control:
                    path = source / control['path']; original = path.read_text()
                    assert original.count(control['before']) == 1
                    changed = original.replace(control['before'], control['after']); path.write_text(changed)
                    write(capture / 'mutation.json', {**control, 'beforeSha256': digest(original.encode()), 'afterSha256': digest(changed.encode())})
                else:
                    candidate = json.loads((source / control['candidate']).read_text())
                    migration = candidate['migrations'][1]
                    migration['up'] = [sql for sql in migration['up'] if sql not in control['remove']]
                    migration['checksum'] = digest(json.dumps(migration['up'], separators=(',', ':'), ensure_ascii=False).encode())
                    path = capture / 'profile-guard-mutant.json'; write(path, candidate)
                    current['guardCandidatePath'] = str(path)
                    write(capture / 'mutation.json', {**control, 'mutantSha256': digest(path.read_bytes()), 'checksum': migration['checksum']})
            write(capture / 'config.json', current)
            parent_resource(current)
            env = {key: os.environ[key] for key in [current['adminEnv']]}
            env.update({'NODE_PATH': str(deps), 'PATH': os.environ['PATH'], 'TZ': 'UTC'})
            known = {}
            with (capture / 'stdout.log').open('wb') as stdout, (capture / 'stderr.log').open('wb') as stderr:
                child = subprocess.Popen(['node', str(source / 'tools/lab/tenant-whole-c/probe.js'), str(capture / 'config.json'), phase], env=env, stdout=stdout, stderr=stderr, start_new_session=True)
                deadline = time.monotonic() + args.timeout
                while child.poll() is None:
                    for birth in group_births(child.pid):
                        known[(birth['pid'], birth['startTicks'])] = birth
                    if time.monotonic() >= deadline:
                        # Exact group created above; never signal an unknown pid.
                        for birth in known.values():
                            now = proc(birth['pid'])
                            if now and now['startTicks'] == birth['startTicks'] and now['uid'] == birth['uid'] and now['group'] == child.pid:
                                os.kill(birth['pid'], signal.SIGCONT); os.kill(birth['pid'], signal.SIGTERM)
                        child.wait(timeout=10)
                        raise AssertionError('timeout is ordinary failure, never semantic red')
                    time.sleep(0.1)
            absence = [{'birth': birth, 'current': proc(birth['pid'])} for birth in known.values()]
            write(capture / 'process-audit.json', absence)
            assert all(row['current'] is None for row in absence), 'owned Node birth remains'
            result = json.loads((capture / 'result.json').read_text())
            assert result['cleanup'] and all(row.get('absent') is True for row in result['cleanup']), 'cleanup incomplete'
            if red:
                failed = [row for row in result['results'] if row['status'] == 'failed']
                assert child.returncode == 1 and len(failed) == 1 and failed[0]['name'] == 'AssertionError'
                assert control['assertion'] in failed[0]['assertion']
                events = [json.loads(line) for line in (capture / 'observations.ndjson').read_text().splitlines()]
                assert physical_control(control, events), 'assertion without intended physical effect'
            else:
                assert child.returncode == 0 and len(result['results']) == (5 if phase == 'all' else 1)
                assert all(row['status'] == 'passed' for row in result['results'])
            summary.append({'label': label, 'phase': phase, 'red': red, 'exit': child.returncode, 'accepted': True})
            write(out / 'campaign.json', summary)
    finally:
        after = inventory(); write(out / 'inventory-after.json', after)
        write(out / 'parent-resource-after.json', parent_resource(config))
        write(out / 'hashes.json', {str(p.relative_to(out)): digest(p.read_bytes()) for p in out.rglob('*') if p.is_file() and p.name != 'hashes.json'})
        assert before == after, 'external baseline changed; preserve unknown resources'
    write(out / 'closure.json', {'sqlCampaignComplete': True, 'parentFixtureRetained': True, 'runtimeReleased': False,
                                 'scope': 'SQL core only; parent must teardown and independently verify resource release; no journey/provider/full-programme acceptance'})
    write(out / 'hashes.json', {str(p.relative_to(out)): digest(p.read_bytes()) for p in out.rglob('*') if p.is_file() and p.name != 'hashes.json'})

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--worktree', type=Path, default=ROOT)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--deps', type=Path)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--grant')
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--stages', choices=['initial', 'controls', 'final', 'all'], default='all')
    args = parser.parse_args()
    if args.check:
        source_check(args.worktree)
    else:
        assert args.out and args.deps and args.config and args.grant and 30 <= args.timeout <= 1800
        campaign(args)
