'use strict';

require('should');

const canonical = require('../lib/registration/canonical');
const fixture = require('./fixtures/registration/example-controller.json');

describe('registration canonical JSON and ids', function () {
  it('sorts members by UTF-16 code unit and writes no whitespace', function () {
    canonical.canonicalJSON({ b: 1, a: [true, null, 'x'], A: { d: 2, c: 'é' } })
      .should.equal('{"A":{"c":"é","d":2},"a":[true,null,"x"],"b":1}');
    canonical.canonicalJSON({ 'é': 1, z: 2, '😀': 3 })
      .should.equal('{"z":2,"é":1,"😀":3}');
  });

  it('writes numbers as ECMAScript does, as RFC 8785 requires', function () {
    canonical.canonicalJSON([1.0, 0.5, 1e21, -0]).should.equal('[1,0.5,1e+21,0]');
    (function () { canonical.canonicalJSON(NaN); }).should.throw();
  });

  it('gives the definition id the specification states for its example', function () {
    canonical.definitionId(fixture.registration).should.equal(fixture.definitionId);
  });

  it('gives the etag the specification states, over registration, state and binding', function () {
    canonical.etag(fixture.registration, 'active', { kind: 'api-secret' }).should.equal(fixture.etagActiveApiSecret);
    canonical.etag(fixture.registration, 'retired', { kind: 'api-secret' }).should.not.equal(fixture.etagActiveApiSecret);
    canonical.etag(fixture.registration, 'active', null).should.not.equal(fixture.etagActiveApiSecret);
  });
});
