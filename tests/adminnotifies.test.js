
'use strict';

require('should');
var language = require('../lib/language')();

const ctx = {};

ctx.bus = {};
ctx.bus.on = function mockOn(channel, f) { };
ctx.settings = {};
ctx.settings.adminNotifiesEnabled = true;

const mockJqueryResults = {};
const mockButton = {};

mockButton.click = function() {};
mockButton.css = function() {};
mockButton.show = function() {};

const mockDrawer = {};

const mockJQuery = function mockJquery(p) {
    if (p == '#adminnotifies') return mockButton;
    if (p == '#adminNotifiesDrawer') return mockDrawer;
    return mockJqueryResults;
};

const mockClient = {};

mockClient.translate = language.translate;
mockClient.headers = function () {return {};}

const adminnotifies = require('../lib/adminnotifies')(ctx);

var window = {};
//global.window = window;

window.setTimeout = function () { return; }

describe('adminnotifies', function ( ) {

    after( function tearDown(done) {
        delete global.window;
        done();
    });

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

      /*
      it('should display a message', function (done) {

        const notify2 = {
            title: 'FooFoo'
            , message: 'BarBar'
        };

        adminnotifies.addNotify(notify2);
        adminnotifies.addNotify(notify2);

        const notifies = adminnotifies.getNotifies();

        mockJQuery.ajax = function mockAjax() {

            const rVal = notifies;

            rVal.done = function(callback) {
                callback({
                    message: {
                        notifies,
                        notifyCount: notifies.length
                        }
                    });
                return rVal;
            }

            rVal.fail = function() {};

            return rVal;
        }

        const adminnotifiesClient = require('../lib/client/adminnotifiesclient')(mockClient,mockJQuery);

        mockDrawer.html = function (html) {
            console.log(html);
            html.indexOf('You have administration messages').should.be.greaterThan(0);
            html.indexOf('Event repeated 2 times').should.be.greaterThan(0);
            done();
        }

        adminnotifiesClient.prepare();

      });
*/

});