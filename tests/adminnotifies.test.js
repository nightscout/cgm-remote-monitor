
'use strict';

const should = require('should');

const ctx = {};

ctx.bus = {};
ctx.bus.on = function mockOn(channel, f) { };

const adminnotifies = require('../lib/adminnotifies')(ctx);

describe('adminnotifies', function ( ) {

    it('should aggregate a message', function () {

        const notify = {
            title: 'Foo'
            , message: 'Bar'
        };

        adminnotifies.addNotify(notify);
        adminnotifies.addNotify(notify);

        const notifies = adminnotifies.getNotifies();

        notifies.length.should.equal(1);
      });

});