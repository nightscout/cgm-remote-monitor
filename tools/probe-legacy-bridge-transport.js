'use strict';

// Diagnostic only: records legacy behavior, including known unsafe TLS acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const {execFileSync} = require('node:child_process');
const {createRequire} = require('node:module');
const {once} = require('node:events');

async function main() {
  const root = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) {
    assert(!process.env[key], 'Run this owned-network probe without proxy environment variables');
  }
  const load = createRequire(path.join(root, 'package.json'));
  const bridge = load('share2nightscout-bridge');
  const minimed = load('minimed-connect-to-nightscout');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-owned-bridge-tls-'));
  let plain, secure, deadline;
  const hits = [], results = {node:process.version, bridge:load('share2nightscout-bridge/package.json').version,
    minimed:load('minimed-connect-to-nightscout/package.json').version, cycles:[]};
  try {
    const key = path.join(tmp, 'key.pem'), cert = path.join(tmp, 'cert.pem');
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-sha256','-nodes','-keyout',key,
      '-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'], {stdio:'ignore', timeout:10000});
    const certificate = fs.readFileSync(cert);
    let plainOrigin, secureOrigin;
    function handler(req, res) {
      const url = new URL(req.url, 'http://127.0.0.1');
      hits.push({path:url.pathname, method:req.method, tls:!!req.socket.encrypted});
      req.resume();
      res.setHeader('Connection','close');
      res.setHeader('Content-Type','application/json');
      if (url.pathname.startsWith('/redirect/')) {
        res.writeHead(Number(url.pathname.split('/').pop()), {Location:(req.socket.encrypted ? plainOrigin : secureOrigin) + '/target'});
        return res.end('{}');
      }
      if (url.pathname === '/auth') return res.end(JSON.stringify('owned-account'));
      if (url.pathname === '/login') return res.end(JSON.stringify('owned-session'));
      if (url.pathname === '/glucose') return res.end(JSON.stringify([{Value:100, DT:'/Date(1700000000000)/', Trend:4}]));
      res.end('{}');
    }
    plain = http.createServer(handler);
    secure = https.createServer({key:fs.readFileSync(key), cert:certificate},handler);
    plain.listen(0,'127.0.0.1'); await once(plain,'listening');
    secure.listen(0,'127.0.0.1'); await once(secure,'listening');
    plainOrigin = 'http://127.0.0.1:' + plain.address().port;
    secureOrigin = 'https://127.0.0.1:' + secure.address().port;
    function native(ca) {
      return new Promise(resolve => {
        const req = https.get(secureOrigin + '/glucose', {ca, timeout:2000}, res => {res.resume(); res.on('end',()=>resolve({status:res.statusCode}));});
        req.on('error',error=>resolve({error:error.code}));
        req.on('timeout',()=>req.destroy(new Error('Owned TLS control timed out')));
      });
    }
    const fetch = uri => new Promise(resolve => bridge.fetch({LatestGlucose:uri,sessionID:'owned-session'},
      (error,response,body)=>resolve({error:error && error.code,status:response && response.statusCode,body})));
    async function run() {
      for (let cycle=0;cycle<2;cycle++) {
        const strict = await native();
        assert.equal(strict.error,'DEPTH_ZERO_SELF_SIGNED_CERT');
        assert.equal((await native(certificate)).status,200);
        const authorization = await new Promise(resolve => bridge.authorize({auth:secureOrigin+'/auth',login:secureOrigin+'/login',
          accountName:'owned-account',password:'owned-fixture-password'},(error,response,body)=>resolve({error:error && error.code,status:response && response.statusCode,body})));
        const glucose = await fetch(secureOrigin+'/glucose');
        const redirects = [];
        for (const origin of [plainOrigin,secureOrigin]) for (const code of [301,302,303,307,308]) {
          const before = hits.filter(hit=>hit.path==='/target').length;
          const response = await fetch(origin+'/redirect/'+code);
          redirects.push({fromTLS:origin===secureOrigin,code,status:response.status,targetHits:hits.filter(hit=>hit.path==='/target').length-before});
        }
        const upload = await new Promise(resolve=>minimed.nightscout.upload([],plainOrigin+'/redirect/302','owned-fixture-secret',
          error=>resolve({rejected:!!error,targetHits:hits.filter(hit=>hit.path==='/target').length})));
        results.cycles.push({strictClientRejectsUntrusted:true,trustedControlSucceeds:true,
          legacyAuthorizationAcceptsUntrusted:!authorization.error && authorization.status===200,
          legacyGlucoseAcceptsUntrusted:!glucose.error && glucose.status===200,redirects,minimedUpload:upload});
      }
    }
    await Promise.race([run(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Owned bridge probe deadline exceeded')),20000);})]);
    results.methods = [...new Set(hits.map(hit=>hit.method))];
    results.warning = 'Diagnostic observations are not a correctness oracle: accepting an untrusted TLS certificate is a known unresolved defect.';
    fs.writeFileSync(output,JSON.stringify(results,null,2)+'\n');
    console.log('Owned legacy transport observations written to ' + output);
  } finally {
    clearTimeout(deadline);
    for (const server of [plain,secure]) if (server) {
      server.closeAllConnections();
      await new Promise(resolve=>server.close(resolve));
    }
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
