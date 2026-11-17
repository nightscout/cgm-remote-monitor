import os,subprocess,json,statistics
from pathlib import Path
import argparse,shutil
parser=argparse.ArgumentParser(description='Compare fresh Nightscout processes against an isolated fixture MongoDB database.')
parser.add_argument('baseline');parser.add_argument('candidate');parser.add_argument('output')
parser.add_argument('--node',default=shutil.which('node'));parser.add_argument('--mongo-uri',required=True)
parser.add_argument('--port',default='17339')
args=parser.parse_args()
out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
node=args.node
roots={'baseline':str(Path(args.baseline).resolve()),'candidate':str(Path(args.candidate).resolve())}
probe=Path(__file__).with_name('connect-server-probe.cjs')
results=[]
for run in range(7):
 for mode in ('disabled','enabled'):
  for label,root in roots.items():
   env={k:os.environ[k] for k in ('PATH','HOME','TMPDIR','LANG') if k in os.environ}
   env.update(API_SECRET='benchmark-fixture-secret',MONGODB_URI=args.mongo_uri,PORT=args.port,HOSTNAME='127.0.0.1',NODE_ENV='production',INSECURE_USE_HTTP='true',ENABLE='careportal connect' if mode=='enabled' else 'careportal',MONGO_POOL_SIZE='5',MONGO_MIN_POOL_SIZE='1')
   proc=subprocess.run([node,'--expose-gc',str(probe),root,mode],env=env,text=True,capture_output=True,timeout=30)
   (out/f'probe-{run}-{label}-{mode}.log').write_text(proc.stdout+proc.stderr)
   if proc.returncode: raise RuntimeError(f'{label} {mode}: '+(proc.stdout+proc.stderr)[-2000:])
   data=json.loads(next(line.removeprefix('PROBE_RESULT ') for line in proc.stdout.splitlines() if line.startswith('PROBE_RESULT ')))
   data['actorAfterTeardown']=json.loads(next(line.removeprefix('PROBE_TEARDOWN ') for line in proc.stdout.splitlines() if line.startswith('PROBE_TEARDOWN ')))['actorStatus']
   data.update(run=run,label=label);results.append(data)
   (out/'server-results.json').write_text(json.dumps(results,indent=2))
   print(run,label,mode,data['memory']['heapUsed'],data['modules'],flush=True)
for mode in ('disabled','enabled'):
 for label in roots:
  rows=[r for r in results if r['mode']==mode and r['label']==label]
  print(mode,label,{key:{'median':statistics.median([r['memory'][key] for r in rows]),'min':min(r['memory'][key] for r in rows),'max':max(r['memory'][key] for r in rows)} for key in ('heapUsed','rss')})
