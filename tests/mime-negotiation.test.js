'use strict';
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const extensions = require('../lib/middleware/express-extension-to-accept');
const renderer = require('../lib/api3/shared/renderer');

describe('API extension negotiation contracts', function () {
  it('preserves all configured v1 formats, original headers and query strings', async function () {
    const formats = {json:'application/json', svg:'image/svg+xml', csv:'text/csv', txt:'text/plain',
      png:'image/png', html:'text/html', js:'application/javascript', tsv:'text/tab-separated-values'};
    const app = express();
    require('../lib/middleware/configure-request')(app);
    app.use(extensions(Object.keys(formats)));
    app.use((req,res) => res.json({url:req.url,accept:req.headers.accept,original:req.extToAccept}));
    for (const [ext,type] of Object.entries(formats)) {
      const url = '/status.' + ext + '?find%5Bname%5D=a%2Bb';
      const result = await request(app).get(url).set('Accept','text/plain').expect(200);
      assert.deepEqual(result.body,{url:'/status?find%5Bname%5D=a%2Bb',accept:type,original:{url,accept:'text/plain'}});
    }
  });
  it('preserves v1 validation and unmatched extension behavior', async function () {
    for (const formats of [null,'json',['bad-format'],['not_a_known_type'],['bin']]) assert.throws(()=>extensions(formats));
    const app=express();app.use(extensions(['json']));
    app.use((req,res)=>res.json({url:req.url,accept:req.headers.accept}));
    for(const ext of ['unknown','JSON']) {
      const result=await request(app).get('/status.'+ext).set('Accept','text/plain');
      assert.deepEqual(result.body,{url:'/status.'+ext,accept:'text/plain'});
    }
  });
  it('preserves v3 rendering aliases, case handling and unsupported responses', async function () {
    const app=express();app.use(renderer.extension2accept);
    app.get('/entries',(req,res)=>renderer.render(res,[{sgv:123}]));
    for(const [ext,type] of [['json','application/json'],['map','application/json'],['csv','text/csv'],
      ['xml','application/xml'],['xsl','application/xml'],['xsd','application/xml'],['rng','application/xml'],
      ['JSON','application/json'],['nested.json','application/json']]) {
      const result=await request(app).get('/entries.'+ext+'?count=1').expect(200);
      assert(result.headers['content-type'].startsWith(type));
      if(type==='application/json') assert.deepEqual(result.body.result,[{sgv:123}]);
      else assert(result.text.includes('123'));
    }
    for(const ext of ['unknown','exe','dll','deb','dmg','iso','msi','asc','wav','mpp','html','jsonld','rdf']) {
      await request(app).get('/entries.'+ext).expect(406);
    }
  });
});
