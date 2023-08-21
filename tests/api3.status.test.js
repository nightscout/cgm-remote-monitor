'use strict';

const request = require('supertest');
require('should');

describe('API3 STATUS', function() {
    const self = this
        , testConst = require('./fixtures/api3/const.json')
        , instance = require('./fixtures/api3/instance')
        , authSubject = require('./fixtures/api3/authSubject')
    ;

    this.timeout(15000);

    before(async () => {
        self.instance = await instance.create({});
        self.app = self.instance.app;
        self.env = self.instance.env;

        let authResult = await authSubject(self.instance.ctx.authorization.storage);

        self.subject = authResult.subject;
        self.token = authResult.token;
    });

    after(function after () {
        self.instance.ctx.bus.teardown();
    });


    it('GET /status', async () => {
        let res = await request(self.app)
            .get(`/api/v3/status?token=${self.token.all}`)
            .expect(200);

        const apiConst = require('../lib/api3/const.json')
            , software = require('../package.json')
            , result = res.body.result;

        res.body.status.should.equal(200);
        result.version.should.equal(software.version);
        result.apiVersion.should.equal(apiConst.API3_VERSION);
        result.storage.storage.should.equal("mongodb");
        result.srvDate.should.be.within(testConst.YEAR_2019, testConst.YEAR_2050);
        result.apiPermissions.devicestatus.should.equal("crud")
        result.apiPermissions.heartrate.should.equal("crud")
    });
});

