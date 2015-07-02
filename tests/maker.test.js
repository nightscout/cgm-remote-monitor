var should = require('should');

describe('maker', function ( ) {
  var maker = require('../lib/plugins/maker')({extendedSettings: {maker: {key: '12345'}}});

  //prevent any calls to iftt
  function noOpMakeRequest (event, eventName, callback) {
    if (callback) { callback(); }
  }

  maker.makeRequest = noOpMakeRequest;

  it('turn values to a query', function (done) {
    maker.valuesToQuery({
      value1: 'This is a title'
      , value2: 'This is the message'
    }).should.equal('?value1=This%20is%20a%20title&value2=This%20is%20the%20message');
    done();
  });

  it('send a request', function (done) {
    maker.sendEvent({name: 'test'}, function sendCallback (err) {
      should.not.exist(err);
      done();
    });
  });

  it('send a allclear, but only once', function (done) {
    function mockedToTestSingleDone (event, eventName, callback) {
      callback(); done();
    }

    maker.makeRequest = mockedToTestSingleDone;
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
