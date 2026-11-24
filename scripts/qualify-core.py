#!/usr/bin/env python3
r"""Run the frozen core's test:all tiers and multitenant corpus on local Docker.

Requires Python 3, Node/npm, Git history (including official/dev) and local Docker.
The work root holds temporary detached worktrees. Output must be a new directory.
Example: scripts/qualify-core.py HEAD --mongo-port 27320 --pg-port 54320 \
  --work-root /mnt/data/nightscout-workspace/worktrees/cgm-remote-monitor \
  --output /mnt/data/nightscout-workspace/artifacts/qualification/run-01
"""
import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
MONGO_IMAGE = 'mongo:8.0.34'
PG_IMAGE = 'postgres:16.15'
DB = 'nightscout_multitenant_test'
MOCHA_COUNT = re.compile(r'^\s*(\d+) (passing|pending|failing)\b')


def git(*args):
    return subprocess.check_output(['git', '-C', REPO, *args], text=True).strip()


def command_log(cmd, cwd, env, path):
    with path.open('w') as log:
        process = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            return process.wait()
        except (KeyboardInterrupt, SystemExit):
            # Let the corpus release its own temporary databases and Vault before taking ours down.
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            process.wait()
            raise


def prepare_tree(stack, dest, sha, env, output):
    git('worktree', 'add', '--detach', str(dest), sha)
    stack.callback(git, 'worktree', 'remove', '--force', str(dest))
    log = output / f'install-{dest.name}.log'
    if command_log(['npm', 'ci', '--include=dev', '--no-audit', '--no-fund', '--prefer-offline'],
                   dest, env, log):
        raise RuntimeError(f'dependency installation failed (see {log})')


def database(stack, scratch, image, port, internal, env, extra, probe):
    # Create before starting so a port collision or failed startup still has an owned ID.
    cidfile = scratch / f'{internal}.cid'

    def remove():
        if cidfile.exists():
            subprocess.run(['docker', 'rm', '--force', '--volumes', cidfile.read_text().strip()], env=env, check=True)

    stack.callback(remove)
    subprocess.run(['docker', 'create', '--cidfile', str(cidfile), '--publish',
                    f'127.0.0.1:{port}:{internal}', *extra, image], env=env, check=True,
                   stdout=subprocess.DEVNULL)
    cid = cidfile.read_text().strip()
    subprocess.run(['docker', 'start', cid], env=env, check=True, stdout=subprocess.DEVNULL)
    # pg_isready over TCP excludes its socket-only init server.
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if subprocess.run(['docker', 'exec', cid, *probe], env=env, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError(f'{image} did not become ready on {port}')


def run_suites(source, reference, output, env, summary, mongo_port, pg_port, password):
    mongo = f'mongodb://127.0.0.1:{mongo_port}/{DB}'
    # with-env gives file values precedence. Put the run-owned endpoint in the CI file copy.
    ci = (source / 'tests/ci.test.env').read_text().splitlines()
    env_file = output / 'tiers.env'
    env_file.write_text('\n'.join(row for row in ci if not row.startswith('CUSTOMCONNSTR_mongo='))
                        + '\nCUSTOMCONNSTR_mongo=' + mongo + '\n')
    env = dict(env, TZ='UTC', TEST_ENV_FILE=str(env_file), CUSTOMCONNSTR_mongo=mongo)
    tier_script = ['node', 'scripts/test-tiers.js']
    # Follow the same set (and order) as npm test:all on the candidate.
    all_tiers = json.loads((source / 'package.json').read_text())['scripts']['test:all']
    match = re.fullmatch(r'node scripts/test-tiers\.js run ([a-zA-Z0-9_,-]+)', all_tiers)
    if not match:
        raise RuntimeError(f'cannot extract tiers from the candidate test:all command: {all_tiers}')
    stages = [('tiers-check', [*tier_script, 'check'])]
    for tier in match[1].split(','):
        stages.append((tier, [*tier_script, 'run', tier]))
    record = output / 'corpus.json'
    stages.append(('corpus', ['node', 'scripts/test-multitenant.js', '--record', str(record)]))
    failed = False
    for name, command in stages:
        stage_env = env
        if name == 'corpus':
            stage_env = dict(env, NS_OFFICIAL_DEV_TREE=str(reference), NS_PARITY_MONGO_URI=mongo,
                             NS_TEST_POSTGRES_ADMIN_URI=f'postgres://postgres:{password}@127.0.0.1:{pg_port}/{DB}',
                             NS_MULTITENANT_POSTGRES_IMAGE=PG_IMAGE, NS_MULTITENANT_MONGO_IMAGE=MONGO_IMAGE)
        log = output / f'{name}.log'
        code = command_log(command, source, stage_env, log)
        counts = {}
        if name == 'corpus' and record.exists():
            counts = json.loads(record.read_text()).get('result') or {}
        elif name != 'tiers-check':
            with log.open(errors='replace') as stream:
                for line in stream:
                    found = MOCHA_COUNT.match(re.sub(r'\x1b\[[0-9;]*m', '', line))
                    if found:
                        counts[found[2]] = int(found[1])
        good = code == 0 and (name == 'tiers-check' or
                              (counts.get('passing', 0) > 0 and counts.get('failing', 0) == 0))
        failed |= not good
        tally = (' ' + ' '.join(f'{key}={counts.get(key, 0)}' for key in ('passing', 'pending', 'failing'))
                 if 'passing' in counts else '')
        print(f'{name} {"PASS" if good else "FAIL"} exit={code}{tally}', file=summary, flush=True)
    return not failed


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('head')
    parser.add_argument('--official-ref', default='official/dev')
    parser.add_argument('--mongo-port', required=True, type=int)
    parser.add_argument('--pg-port', required=True, type=int)
    parser.add_argument('--work-root', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if not all(0 < port <= 65535 for port in (args.mongo_port, args.pg_port)) or args.mongo_port == args.pg_port:
        parser.error('choose two distinct local TCP ports')
    source, reference = (git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}')
                         for ref in (args.head, args.official_ref))
    if git('rev-parse', '--is-shallow-repository') == 'true':
        parser.error('full Git history is required for the corpus')
    output = args.output.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    summary_path = output / 'summary.txt'
    print(summary_path, flush=True)
    # Keep site credentials, database URLs and inherited opt-ins out of both test runs.
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'USER', 'LANG') if k in os.environ}
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    with summary_path.open('w', buffering=1) as summary:
        print(f'candidate={source} official={reference}', file=summary)
        print(f'mongo={MONGO_IMAGE} port={args.mongo_port} postgres={PG_IMAGE} port={args.pg_port}', file=summary)
        try:
            with ExitStack() as stack:
                scratch = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='q', dir='/tmp')))
                env.update(TMPDIR=str(scratch), TZ='UTC')
                work = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='qualify-', dir=args.work_root.resolve())))
                tree, official = work / 'candidate', work / 'official'
                prepare_tree(stack, tree, source, env, output)
                prepare_tree(stack, official, reference, env, output)
                password = secrets.token_hex(24)
                database(stack, scratch, MONGO_IMAGE, args.mongo_port, 27017, env, ['--ulimit', 'nofile=64000:64000'],
                         ['mongosh', '--quiet', '--eval', 'db.adminCommand({ping:1})'])
                database(stack, scratch, PG_IMAGE, args.pg_port, 5432,
                         dict(env, POSTGRES_DB=DB, POSTGRES_PASSWORD=password), ['-e', 'POSTGRES_DB', '-e', 'POSTGRES_PASSWORD'],
                         ['pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', DB])
                passed = run_suites(tree, official, output, env, summary, args.mongo_port, args.pg_port, password)
        except (OSError, ValueError, subprocess.SubprocessError, RuntimeError, KeyboardInterrupt, SystemExit) as error:
            print(f'ERROR {error}', file=summary)
            passed = False
        print('DONE ' + ('PASS' if passed else 'FAIL'), file=summary)
        return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
