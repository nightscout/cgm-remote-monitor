var should = require('should');
var levels = require('../lib/levels');

describe('maker', function ( ) {
  var maker = require('../lib/plugins/maker')(
    {
      extendedSettings: {maker: {key: '12345'}}
      , levels: levels
  });

  //prevent any calls to iftt
  function noOpMakeRequest (key, event, eventName, callback) {
    if (callback) { callback(); }
  }

  maker.makeKeyRequest = noOpMakeRequest;

  it('turn values to a query', function (done) {
    maker.valuesToQuery({
      value1: 'This is a title'
      , value2: 'This is the message'
    }).should.equal('?value1=This%20is%20a%20title&value2=This%20is%20the%20message');
    done();
  });

  it('send a request', function (done) {
    maker.sendEvent({name: 'test', message: 'This is the message', level: levels.toLowerCase(levels.WARN)}, function sendCallback (err) {
      should.not.exist(err);
      done();
    });
  });

  it('not send a request without a name', function (done) {
    maker.sendEvent({level: levels.toLowerCase(levels.WARN)}, function sendCallback (err) {
      should.exist(err);
      done();
    });
  });

  it('not send a request without a level', function (done) {
    maker.sendEvent({name: 'test'}, function sendCallback (err) {
      should.exist(err);
      done();
    });
  });

  it('send a allclear, but only once', function (done) {
    function mockedToTestSingleDone (key, event, eventName, callback) {
      callback(); done();
    }

    maker.makeKeyRequest = mockedToTestSingleDone;
    maker.sendAllClear({}, function sendCallback (err, result) {
      should.not.exist(err);
      result.sent.should.equal(true);
    });

    //send again, if done is called again test will fail
    maker.sendAllClear({}, function sendCallback (err, result) {
      should.not.exist(err);
      result.sent.should.equal(false);
    });
  });
});


describe('multi announcement maker', function ( ) {
  var maker = require('../lib/plugins/maker')({extendedSettings: {maker: {key: 'use announcementKey instead', announcementKey: '12345 6789'}}});

  it('send 2 requests for the 2 keys', function (done) {

    var key1Found = false;
    var key2Found = false;

    maker.makeKeyRequest = function expect2Keys (key, event, eventName, callback) {
      if (callback) { callback(); }

      key1Found = key1Found || key === '12345';
      key2Found = key2Found || key === '6789';

      if (eventName === 'ns-warning-test' && key1Found && key2Found) {
        done();
      }
    };

    maker.sendEvent({name: 'test', level: levels.toLowerCase(levels.WARN), isAnnouncement: true}, function sendCallback (err) {
      should.not.exist(err);
    });
  });

});
