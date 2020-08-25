'use strict';

require('should');

// This test is included just so we have an easy to template to intentionally cause
// builds to fail

describe('fail', function ( ) {

  it('should not fail', function () {
    true.should.equal(true);
  });

});
