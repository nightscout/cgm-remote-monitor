import json, os, pathlib, subprocess, time

root = pathlib.Path(__file__).parent
prefix = 'nsp-t2-3466-20261110'
image = 'carrotsoup/cgm-remote-monitor:15.0.9-modern-c9e8b50a@sha256:640e7c4db7ba567c99a2275ce6b4f2ef005d58ef93d5891afaab469f8d65fce9'
uri = 'mongodb://127.0.0.1:27017/test_nsp_t2_3466_20261110'
label = 'support.isolated-test=' + prefix
platform = os.environ.get('NSP_TEST_PLATFORM')
candidate_image = os.environ.get('NSP_TEST_CANDIDATE_IMAGE')
assert platform in [None, 'linux/amd64']
assert candidate_image in [None, 'nsp-t2-review:3466-c9e8b50a-cross-api-amd64']
suffix = '-amd64' if platform else ''
if platform:
    # Dockerfile.base-review contains only the pinned FROM. Loading it by
    # a local tag avoids a classic-store arm64/amd64 digest collision.
    image = 'nsp-t2-review:3466-base-amd64'

def run(args, **kw):
    return subprocess.run(args, text=True, check=True, capture_output=True, **kw).stdout.strip()

owned = []
network = False
try:
    run(['docker','network','create','--internal','--label',label,prefix]); network = True
    run(['docker','run','-d','--name',prefix+'-mongo','--label',label,'--network',prefix,'mongo:7','--bind_ip_all']); owned.append(prefix+'-mongo')
    for attempt in range(40):
        try:
            run(['docker','exec',prefix+'-mongo','mongosh','--quiet','--eval','db.adminCommand({ping:1})']); break
        except subprocess.CalledProcessError:
            if attempt == 39: raise
            time.sleep(.5)
    for mode in ['baseline','candidate']:
        name = prefix+'-'+mode
        command = ['docker','run','-d','--name',name,'--label',label,'--network','container:'+prefix+'-mongo']
        if platform: command += ['--platform',platform]
        for key, value in {'MONGO_CONNECTION':uri,'CUSTOMCONNSTR_mongo':uri,'MONGODB_URI':uri,'NODE_ENV':'test','CI':'true','API_SECRET':'this is my long pass phrase','AUTH_DEFAULT_ROLES':'readable','INSECURE_USE_HTTP':'true','NIGHTSCOUT_HOSTNAME':'0.0.0.0','PORT':'1337','ENABLE':'api careportal','AUTH_FAIL_DELAY':'0'}.items():
            command += ['-e',key+'='+value]
        command += ['-v',str(root/'integration-cross-api.js')+':/tmp/integration-cross-api.js:ro']
        if mode == 'candidate' and not candidate_image:
            for source in ['lib/server/entries.js','lib/api3/generic/create/operation.js','lib/api3/generic/update/replace.js','lib/api3/generic/update/validate.js']:
                command += ['-v',str(root/source)+':/opt/app/'+source+':ro']
        command += [candidate_image if mode == 'candidate' and candidate_image else image]
        run(command); owned.append(name)
        try:
            result = run(['docker','exec',name,'node','/tmp/integration-cross-api.js',mode],timeout=65)
            (root/(mode+'-result'+suffix+'.json')).write_text(result+'\n')
            print(result,flush=True)
        except Exception as error:
            if isinstance(error,subprocess.CalledProcessError):
                print(error.stderr,flush=True)
            print(run(['docker','logs','--tail','50',name]),flush=True)
            raise
        finally:
            run(['docker','rm','-f',name]); owned.remove(name)
    command = ['docker','run','--rm','--name',prefix+'-regressions','--label',label,'--network','container:'+prefix+'-mongo',
        '-e','MONGO_CONNECTION='+uri,'-e','CUSTOMCONNSTR_mongo='+uri,'-e','MONGODB_URI='+uri,
        '-e','NODE_ENV=test','-e','CI=true','-e','INSECURE_USE_HTTP=true','-e','NODE_PATH=/test-tools/node_modules',
        '-v',str(root/'tests')+':/opt/app/tests:ro','-v',str(root/'test-tools')+':/test-tools:ro']
    if platform: command += ['--platform',platform]
    if not candidate_image:
        for source in ['lib/server/entries.js','lib/api3/generic/create/operation.js','lib/api3/generic/update/replace.js','lib/api3/generic/update/validate.js']:
            command += ['-v',str(root/source)+':/opt/app/'+source+':ro']
    command += ['--entrypoint','node',candidate_image or image,'/test-tools/node_modules/mocha/bin/mocha.js',
        '--require','/opt/app/tests/hooks.js','--timeout','15000','--exit','--reporter','spec']
    command += ['/opt/app/tests/'+f for f in ['api.entries.test.js','api.entries.uuid.test.js','api.entries.repost-with-id.test.js','api.entries.unknown-id.test.js','api.entries.upper-case-id.test.js','api.object-id.treatments-entries.test.js','api3.create.test.js','api3.create.operation.test.js','api3.shape-handling.test.js','api3.update.operation.security.test.js']]
    completed = subprocess.run(command,text=True,capture_output=True,timeout=120)
    (root/('existing-regressions'+suffix+'.log')).write_text(completed.stdout+'\n'+completed.stderr)
    print('\n'.join(completed.stdout.splitlines()[-10:]),flush=True)
    completed.check_returncode()
finally:
    for name in reversed(owned):
        metadata=json.loads(run(['docker','inspect',name]))[0]
        assert metadata['Config']['Labels'].get('support.isolated-test')==prefix
        run(['docker','rm','-f',name])
    if network: run(['docker','network','rm',prefix])
