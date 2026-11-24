"""Regression control for a failed tier followed by a passing corpus. Run with python3."""
from importlib.util import module_from_spec, spec_from_file_location
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = spec_from_file_location('qualification', Path(__file__).with_name('qualify-core.py'))
runner = module_from_spec(spec)
spec.loader.exec_module(runner)


class QualificationTest(unittest.TestCase):
    def test_failed_tier_survives_passing_corpus_and_teardown(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            repo = root / 'repo'
            work = root / 'trees'
            output = root / 'results'
            work.mkdir()
            repo.mkdir()
            (repo / 'tests').mkdir()
            (repo / 'scripts').mkdir()
            # Dependency-free stand-in for a candidate, including a real failing Node test.
            (repo / 'package.json').write_text(json.dumps({
                'name': 'qualification-control', 'version': '1.0.0',
                'scripts': {'test:all': 'node scripts/test-tiers.js run unit,core'}}))
            (repo / 'package-lock.json').write_text(json.dumps({
                'name': 'qualification-control', 'version': '1.0.0', 'lockfileVersion': 3,
                'packages': {'': {'name': 'qualification-control', 'version': '1.0.0'}}}))
            (repo / 'tests/ci.test.env').write_text('CUSTOMCONNSTR_mongo=original\n')
            (repo / 'scripts/test-tiers.js').write_text("""
const assert = require('node:assert/strict');
const fs = require('node:fs');
if (process.argv[2] === 'run') {
  assert.match(fs.readFileSync(process.env.TEST_ENV_FILE, 'utf8'), /127\\.0\\.0\\.1:27777/);
  const {status} = require('node:child_process').spawnSync(process.execPath, ['--test', 'tests/' + process.argv[3] + '.js'], {stdio: 'inherit'});
  console.log(status === 0 ? '  1 passing' : '  0 passing\\n  1 failing');
  process.exit(status);
}
""")
            (repo / 'tests/unit.js').write_text("require('node:test')('broken property', () => require('node:assert/strict').equal(1, 2));")
            (repo / 'tests/core.js').write_text("require('node:test')('passing property', () => {});")
            (repo / 'scripts/test-multitenant.js').write_text("""
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(fs.readFileSync(process.env.NS_OFFICIAL_DEV_TREE + '/ref.txt', 'utf8'), 'original');
fs.writeFileSync(process.argv[3], JSON.stringify({result: {passing: 1, pending: 0, failing: 0}}));
""")
            (repo / 'ref.txt').write_text('original')
            def git(*args):
                return subprocess.check_output(['git', '-C', repo, *args], text=True).strip()
            git('init', '-q')
            git('add', '.')
            git('-c', 'user.name=Qualification', '-c', 'user.email=qualification@example.test',
                'commit', '-qm', 'control')
            reference = git('rev-parse', 'HEAD')
            (repo / 'ref.txt').write_text('candidate')
            git('-c', 'user.name=Qualification', '-c', 'user.email=qualification@example.test',
                'commit', '-qam', 'candidate')
            argv = ['qualify', 'HEAD', '--official-ref', reference, '--mongo-port', '27777',
                    '--pg-port', '54777', '--work-root', str(work), '--output', str(output)]
            # Only provisioning is substituted. Both installs, checkouts, child exits,
            # summary and worktree teardown go through the normal entry point.
            with patch.object(runner, 'REPO', repo), patch.object(sys, 'argv', argv), patch.object(runner, 'database'):
                self.assertEqual(runner.main(), 1)
                red = (output / 'summary.txt').read_text()
                self.assertIn('unit FAIL exit=1 passing=0 pending=0 failing=1', red)
                self.assertIn('corpus PASS exit=0 passing=1 pending=0 failing=0', red)
                self.assertTrue(red.endswith('DONE FAIL\n'))
                (repo / 'tests/unit.js').write_text((repo / 'tests/core.js').read_text())
                git('-c', 'user.name=Qualification', '-c', 'user.email=qualification@example.test',
                    'commit', '-qam', 'restore property')
                argv[-1] = str(root / 'restored')
                self.assertEqual(runner.main(), 0)
                self.assertTrue((root / 'restored/summary.txt').read_text().endswith('DONE PASS\n'))
                self.assertEqual(git('worktree', 'list', '--porcelain').count('worktree '), 1)
                self.assertEqual(list(work.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
