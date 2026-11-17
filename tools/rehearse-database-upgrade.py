"""Rehearse owned standalone 5->6->7->8 upgrades and backup restore rollback.

Creates only UUID-named Docker volumes/containers and a fresh output directory.
No deployment URI, existing container, volume or database can be supplied.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', help='New directory for synthetic backups and evidence')
parser.add_argument('--node', default=shutil.which('node'))
args = parser.parse_args()
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=False)
root = Path(__file__).resolve().parent.parent
suffix = uuid.uuid4().hex[:12]
database = 'nightscout_upgrade_' + suffix
prefix = 'nightscout-upgrade-' + suffix
versions = ['5.0.32', '6.0.27', '7.0.40', '8.0.29']
containers, volumes, evidence = [], [], []
expected = out / 'expected.json'

metadata = {'scope': 'Owned synthetic standalone databases; no production or replica-set upgrade claim',
            'gitHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
            'node': subprocess.check_output([args.node, '--version'], text=True).strip(),
            'sourceLockSha256': hashlib.sha256(subprocess.check_output(['git', 'show', 'HEAD:package-lock.json'], cwd=root)).hexdigest(),
            'postPruneLockSha256': hashlib.sha256((root / 'package-lock.json').read_bytes()).hexdigest(),
            'sources': {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                        for name in ['tools/database-upgrade-fixture.cjs', 'tools/rehearse-database-upgrade.py']}}
(out / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')


def command(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, timeout=180, **kwargs)


def docker(*argv):
    return command(['docker', *argv], text=True).stdout.strip()


def volume(label):
    name = prefix + '-' + label
    docker('volume', 'create', '--label', 'nightscout.fixture=database-upgrade', name)
    volumes.append(name)
    return name


def start(version, data, label):
    name = prefix + '-' + label
    docker('run', '--detach', '--name', name, '--label', 'nightscout.fixture=database-upgrade',
           '--publish', '127.0.0.1::27017', '--mount', 'type=volume,src=' + data + ',dst=/data/db',
           '--env', 'MONGO_INITDB_ROOT_USERNAME=fixture', '--env', 'MONGO_INITDB_ROOT_PASSWORD=owned-upgrade-fixture',
           'mongo:' + version, '--bind_ip_all')
    containers.append(name)
    port = docker('port', name, '27017/tcp').removeprefix('127.0.0.1:')
    assert port.isdigit()
    return name, port


def worker(mode, port, fcv=None):
    argv = [args.node, str(root / 'tools/database-upgrade-fixture.cjs'), mode, port, database, str(expected)]
    if fcv:
        argv.append(fcv)
    result = command(argv, text=True)
    return json.loads(result.stdout)


def backup(name, label):
    archive = out / (label + '.archive')
    result = command(['docker', 'exec', name, 'mongodump', '--username=fixture', '--password=owned-upgrade-fixture',
                      '--authenticationDatabase=admin', '--db=' + database, '--archive'])
    archive.write_bytes(result.stdout)
    assert archive.stat().st_size > 0
    return archive


try:
    data = volume('data')
    first_backup = None
    for index, version in enumerate(versions):
        started = time.monotonic()
        name, port = start(version, data, 'v' + version)
        before = worker('seed' if index == 0 else 'verify', port)
        assert before['version'] == version
        assert before['fcv']['version'] == (versions[index - 1] if index else version).rsplit('.', 1)[0]
        after = worker('fcv', port, version.rsplit('.', 1)[0]) if index else before
        archive = backup(name, 'mongo-' + version)
        if first_backup is None:
            first_backup = archive
        evidence.append({'stage': version, 'beforeFcvChange': before, 'afterFcvChange': after,
                         'elapsedSeconds': round(time.monotonic() - started, 3),
                         'image': json.loads(docker('image', 'inspect', 'mongo:' + version))[0]['RepoDigests'],
                         'backupBytes': archive.stat().st_size,
                         'backupSha256': hashlib.sha256(archive.read_bytes()).hexdigest()})
        (out / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print('Verified MongoDB', version, 'before/after FCV and backed up synthetic data', flush=True)
        docker('stop', '--time', '30', name)
    # Restore the original pre-upgrade backup into a NEW MongoDB 5 volume.
    # Do not start old binaries against the upgraded volume or imply FCV rollback.
    for restore_version, restore_archive, label in [(versions[0], first_backup, 'rollback-original-on-5'),
                                                    (versions[-1], archive, 'restore-final-on-8')]:
        name, port = start(restore_version, volume(label), label)
        for attempt in range(120):
            try:
                docker('exec', name, 'mongosh', '--quiet', '--username=fixture', '--password=owned-upgrade-fixture',
                       '--authenticationDatabase=admin', '--eval', 'db.adminCommand({ping:1})')
                break
            except subprocess.CalledProcessError:
                if attempt == 119:
                    raise
                time.sleep(0.25)
        docker('cp', str(restore_archive), name + ':/tmp/fixture.archive')
        docker('exec', name, 'mongorestore', '--username=fixture', '--password=owned-upgrade-fixture',
               '--authenticationDatabase=admin', '--archive=/tmp/fixture.archive')
        evidence.append({'stage': label, 'verification': worker('verify', port)})
        (out / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print('Verified backup restore on fresh MongoDB', restore_version, flush=True)
except subprocess.CalledProcessError as error:
    (out / 'failure.txt').write_text(str(error.stderr) + '\n' + str(error.stdout))
    raise
finally:
    cleanup_errors = []
    for name in reversed(containers):
        try:
            (out / (name + '.log')).write_text(docker('logs', name))
        except subprocess.CalledProcessError:
            pass
        try:
            docker('rm', '--force', name)
        except subprocess.CalledProcessError as error:
            cleanup_errors.append((name, error.stderr))
    for name in volumes:
        try:
            docker('volume', 'rm', name)
        except subprocess.CalledProcessError as error:
            cleanup_errors.append((name, error.stderr))
    if cleanup_errors:
        raise RuntimeError('Owned resource cleanup failed: ' + str(cleanup_errors))
    metadata['ownedResourcesRemoved'] = {'containers': len(containers), 'volumes': len(volumes)}
    (out / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
