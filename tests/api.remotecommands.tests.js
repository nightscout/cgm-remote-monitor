'use strict';

var _ = require('lodash');
var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('Remote Commands API', function ( ) {
  this.timeout(10000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  var api = require('../lib/api/');
  beforeEach(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    this.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });

  it('POST, GET, PUT, GET', async function() {

    //Remove any lingering remote commands
    await deleteAllRecords()

    const testStartDateInMs = Date.now().valueOf()

    //POST Remote Command

    const postResponse = await request(self.app)
    .post('/api/remotecommands/')
    .set('api-secret', known || '')
    .send({
      eventType: "bolus",
      otp: 12345,
      sendNotification: false,
      status: {
        state: "Pending",
        message: "Action queued"
      },
      payload: {
        units: 1.0,
        absorption: 3.0
      }
    })
    
    console.log(JSON.stringify(postResponse.body[0]));

    postResponse.headers["content-type"].should.match(/json/)
    postResponse.status.should.equal(200)
    postResponse.body[0].eventType.should.equal("bolus")
    postResponse.body[0].otp.should.equal(12345)
    postResponse.body[0].sendNotification.should.equal(false)
    postResponse.body[0].status.state.should.equal("Pending")
    postResponse.body[0].status.message.should.equal("Action queued")
    postResponse.body[0].payload.units.should.equal(1.0)
    postResponse.body[0].payload.absorption.should.equal(3.0)

    const idFromPost = postResponse.body[0]._id
    const insertDateStringFromPost = postResponse.body[0].created_at
    const insertDateFromPost = Date.parse(insertDateStringFromPost)
    
    testStartDateInMs.should.lessThanOrEqual(insertDateFromPost)
    Date.now().valueOf().should.greaterThanOrEqual(insertDateFromPost)

    //GET Remote Command

    const getResponse = await request(self.app)
    .get('/api/remotecommands/')
    .query(`find[created_at][$eq]=${insertDateStringFromPost}`)
    .set('api-secret', known || '')
    console.log(JSON.stringify(getResponse.body[0]));

    getResponse.headers["content-type"].should.match(/json/)
    getResponse.status.should.equal(200)
    getResponse.body.length.should.equal(1)
    getResponse.body[0].eventType.should.equal("bolus")
    getResponse.body[0].otp.should.equal(12345)
    getResponse.body[0].sendNotification.should.equal(false)
    getResponse.body[0].status.state.should.equal("Pending")
    getResponse.body[0].status.message.should.equal("Action queued")
    getResponse.body[0].payload.units.should.equal(1.0)
    getResponse.body[0].payload.absorption.should.equal(3.0)
    const insertDateFromGet = Date.parse(getResponse.body[0].created_at)
    insertDateFromGet.should.equal(insertDateFromPost)

    //PUT Remote Command

    const putResponse = await request(self.app)
    .put('/api/remotecommands/')
    .set('api-secret', known || '')
    .send({
      _id:  idFromPost, //Use same ID to perform an update.
      created_at: insertDateStringFromPost,
      eventType: "bolus",
      otp: 12345,
      sendNotification: false,
      status: {
        state: "Success",
        message: "Units Delivered"
      },
      payload: {
        units: 1.0,
        absorption: 3.0
      }
    })

    putResponse.headers["content-type"].should.match(/json/)
    putResponse.status.should.equal(200)

    console.log(JSON.stringify(putResponse));
    should(putResponse.body == undefined) //No Body in PUT

    //GET Remote Command

    const get2Response = await request(self.app)
    .get('/api/remotecommands/')
    .query(`find[created_at][$eq]=${insertDateStringFromPost}`)
    .set('api-secret', known || '')
    console.log(JSON.stringify(get2Response.body[0]));

    get2Response.headers["content-type"].should.match(/json/)
    get2Response.status.should.equal(200)
    get2Response.body.length.should.equal(1)
    get2Response.body[0].eventType.should.equal("bolus")
    get2Response.body[0].otp.should.equal(12345)
    get2Response.body[0].sendNotification.should.equal(false)
    get2Response.body[0].status.state.should.equal("Success")
    get2Response.body[0].status.message.should.equal("Units Delivered")
    get2Response.body[0].payload.units.should.equal(1.0)
    get2Response.body[0].payload.absorption.should.equal(3.0)
    const idFromGet = get2Response.body[0]._id
    idFromPost.should.equal(idFromGet)
  });

  //TODO: Put this in beforeEach?
  //I can't put an async method 
  //in there but maybe can put the callback variant?
  async function deleteAllRecords(){
    //Delete all remotecommands
    await request(self.app)
    .delete('/api/remotecommands/*')
    // .query(`find[_id][$eq]=*`)
    .set('api-secret', known || '')
  }

});
