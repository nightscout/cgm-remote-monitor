#!/usr/bin/env python3
"""Compare owned watch fixtures; does not start Nightscout or touch its data."""
import argparse, json, os, pathlib, re, selectors, signal, subprocess, tempfile, time, urllib.request

p = argparse.ArgumentParser()
p.add_argument('--node', required=True)
p.add_argument('--dependency-root', required=True)
p.add_argument('--output', required=True)
a = p.parse_args()
def terminate(signum, frame):
    raise SystemExit(128 + signum)
signal.signal(signal.SIGTERM, terminate)
repo = pathlib.Path(__file__).resolve().parents[1]
package = json.loads((repo / 'package.json').read_text())
dep = pathlib.Path(a.dependency_root).resolve()
node = str(pathlib.Path(a.node).resolve())
results = {'node': subprocess.check_output([node, '--version'], text=True).strip(),
           'platform': os.uname().sysname, 'nodemon': json.loads((dep / 'node_modules/nodemon/package.json').read_text())['version'],
           'configuration': package['nodemonConfig'], 'variants': {}}
for mode in ['nodemon', 'native']:
    with tempfile.TemporaryDirectory(prefix='nightscout-owned-watch-') as tmp:
        root = pathlib.Path(tmp)
        for folder in ['lib', 'static', 'tests', 'bin', 'node_modules/owned-watch-dep']:
            (root / folder).mkdir(parents=True)
        (root / 'watch.json').write_text(json.dumps(package['nodemonConfig']))
        (root / 'lib/loaded.js').write_text('module.exports=0;\n')
        (root / 'static/unimported.js').write_text('// initial\n')
        (root / 'node_modules/owned-watch-dep/index.js').write_text('module.exports=0;\n')
        (root / 'lib/main.js').write_text("const value=require('./loaded');require('owned-watch-dep');console.log(JSON.stringify({boot:true,pid:process.pid,node:process.version,value}));setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));\n")
        command = [node]
        if mode == 'nodemon':
            command += [str(dep / 'node_modules/nodemon/bin/nodemon.js'), '--config', str(root / 'watch.json')]
        else:
            command += ['--watch', '--watch-preserve-output']
        command += ['--inspect=127.0.0.1:0', 'lib/main.js']
        child = subprocess.Popen(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 start_new_session=True, bufsize=0,
                                 env={'PATH': str(pathlib.Path(node).parent) + os.pathsep + os.environ.get('PATH', ''), 'NODE_ENV': 'test'})
        selector = selectors.DefaultSelector(); selector.register(child.stdout, selectors.EVENT_READ)
        pending = b''; boots = []; inspectors = []; lines = []
        def observe(seconds):
            global pending
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise RuntimeError('Watcher stopped: ' + '\n'.join(lines[-20:]))
                for key, _ in selector.select(min(.1, max(0, deadline-time.monotonic()))):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk: continue
                    pending += chunk
                    while b'\n' in pending:
                        line, pending = pending.split(b'\n', 1)
                        line = line.decode(errors='replace'); lines.append(line)
                        if line.startswith('{"boot":'):
                            boot = json.loads(line)
                            assert boot['node'] == results['node'], ('Unexpected child runtime', boot)
                            boots.append(boot)
                        match = re.search(r'ws://127\.0\.0\.1:(\d+)/', line)
                        if match: inspectors.append(int(match.group(1)))
        def wait_boot(count):
            deadline = time.monotonic() + 10
            while len(boots) < count and time.monotonic() < deadline: observe(.1)
            if len(boots) != count: raise AssertionError(('boot count', mode, count, boots, lines[-10:]))
        def inspector():
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:' + str(inspectors[-1]) + '/json/list', timeout=2) as response:
                targets = json.load(response)
            assert len(targets) == 1 and targets[0]['type'] == 'node'
            target = targets[0]['webSocketDebuggerUrl']
            assert target.startswith('ws://127.0.0.1:' + str(inspectors[-1]) + '/')
            # Connect to the new process's inspector, not merely its discovery URL.
            script = """
const assert = require('node:assert/strict');
const socket = new WebSocket(process.argv[1]);
const timeout = setTimeout(() => process.exit(2), 4000);
socket.addEventListener('error', () => process.exit(3));
socket.addEventListener('open', () => socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'process.pid',returnByValue:true}})));
socket.addEventListener('message', event => {
  const response = JSON.parse(event.data);
  if (response.id !== 1) return;
  assert.equal(response.result.result.value, Number(process.argv[2]));
  console.log(response.result.result.value);
  socket.close();
});
socket.addEventListener('close', () => clearTimeout(timeout));
"""
            evaluated = int(subprocess.check_output([node, '-e', script, target, str(boots[-1]['pid'])], timeout=6, text=True, env={'PATH': str(pathlib.Path(node).parent) + os.pathsep + os.environ.get('PATH', ''), 'NODE_ENV': 'test'}))
            assert evaluated == boots[-1]['pid']
            return {'pid': boots[-1]['pid'], 'inspectorReachable': True, 'inspectorEvaluatedPid': evaluated}
        try:
            wait_boot(1); observe(1)
            record = {'initial': inspector(), 'cycles': []}
            for cycle in range(2):
                sample = {}
                for file in ['tests/ignored.js', 'bin/ignored.js', 'static/unimported.js', 'node_modules/owned-watch-dep/index.js', 'lib/loaded.js']:
                    before = len(boots)
                    content = 'module.exports=' + str(cycle+1) + ';\n'
                    (root / file).write_text(content)
                    observe(1.5)
                    sample[file] = len(boots)-before
                    if file == 'lib/loaded.js':
                        wait_boot(before+1)
                        assert boots[-1]['value'] == cycle+1
                        sample['debuggerAfterRestart'] = inspector()
                record['cycles'].append(sample)
            record['boots'] = boots
            results['variants'][mode] = record
        finally:
            try: os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
            selector.close(); child.stdout.close()
pathlib.Path(a.output).write_text(json.dumps(results, indent=2)+'\n')
print(json.dumps(results, indent=2))
