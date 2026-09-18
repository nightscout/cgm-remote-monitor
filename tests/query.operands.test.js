'use strict';

require('should');

const qs = require('qs');
const query = require('../lib/server/query.js');

/**
 * BF-40. An operator whose operand is a yes/no question, not a value drawn
 * from the field, still arrives from the query string as text. MongoDB reads
 * ANY string as true -- including "false", "0" and "" -- so
 * `find[x][$exists]=false` was answered with exactly the documents it asked to
 * exclude, under HTTP 200, with nothing to warn the caller.
 *
 * Measured against live mongod 3.6.8 and 7.0.43, identical on both, over the
 * documents [{_id: 1, sgv: 100}, {_id: 2}]:
 *
 *   {$exists: false} -> [2]    {$exists: "false"} -> [1]
 *   {$exists: 0}     -> [2]    {$exists: "0"}     -> [1]
 *   {$exists: null}  -> [2]    {$exists: ""}      -> [1]
 */
describe('query operand readers', function ( ) {

  function find (q, opts) {
    return query(qs.parse(q), Object.assign({ walker: { } , dateField: 'created_at' }, opts));
  }

  describe('$exists', function ( ) {

    it('reads "false" as the boolean false', function ( ) {
      find('find[madeUpField][$exists]=false').madeUpField.$exists.should.equal(false);
    });

    it('reads "true" as the boolean true', function ( ) {
      find('find[madeUpField][$exists]=true').madeUpField.$exists.should.equal(true);
    });

    it('reads "0" and "1"', function ( ) {
      find('find[madeUpField][$exists]=0').madeUpField.$exists.should.equal(false);
      find('find[madeUpField][$exists]=1').madeUpField.$exists.should.equal(true);
    });

    it('is case insensitive', function ( ) {
      find('find[madeUpField][$exists]=False').madeUpField.$exists.should.equal(false);
      find('find[madeUpField][$exists]=TRUE').madeUpField.$exists.should.equal(true);
    });

    // The decision, pinned so that changing it is deliberate. `?find[x][$exists]`
    // with no value parses to '' and is as easily "yes, I want this flag" as
    // "no". Reading it either way would silently invert somebody's query, which
    // is the defect this fix removes -- not a licence to commit it the other way.
    it('LEAVES an empty operand alone rather than guessing', function ( ) {
      find('find[madeUpField][$exists]=').madeUpField.$exists.should.equal('');
    });

    it('leaves an unrecognised operand alone', function ( ) {
      find('find[madeUpField][$exists]=yes').madeUpField.$exists.should.equal('yes');
    });

    it('passes a non-string operand through untouched', function ( ) {
      const out = query({ find: { madeUpField: { $exists: false } } }, { walker: { }, dateField: 'created_at' });
      out.madeUpField.$exists.should.equal(false);
    });

    // The operand is reached by operator, not by position, so wrapping it
    // changes nothing. Measured: {sgv: {$not: {$exists: "false"}}} returns the
    // document that HAS sgv, i.e. the inverse of the inverse of the request.
    it('reads the operand at any depth, including under $not', function ( ) {
      find('find[madeUpField][$not][$exists]=false').madeUpField.$not.$exists.should.equal(false);
    });

    it('reads the operand inside an $or array', function ( ) {
      const out = query({
        find: { $or: [{ a: { $exists: 'false' } }, { b: { $exists: 'true' } }] }
      }, { walker: { }, dateField: 'created_at' });
      out.$or[0].a.$exists.should.equal(false);
      out.$or[1].b.$exists.should.equal(true);
    });
  });

  describe('operators that are NOT boolean questions', function ( ) {

    // $regex wants a string and already gets one; reading it as a boolean
    // would break the pattern "0" or "1". This pins that the reader does not
    // generalise beyond the operators whose operand really is a yes/no answer.
    it('leaves $regex alone, including patterns that look boolean', function ( ) {
      find('find[notes][$regex]=ab').notes.$regex.should.equal('ab');
      find('find[notes][$regex]=0').notes.$regex.should.equal('0');
      find('find[notes][$regex]=true').notes.$regex.should.equal('true');
    });

    it('leaves $options, $type and $text alone', function ( ) {
      find('find[notes][$options]=i').notes.$options.should.equal('i');
      find('find[sgv][$type]=number').sgv.$type.should.equal('number');
    });

    // A field value that happens to spell a boolean is a VALUE, not an
    // operand, and must not be converted.
    it('leaves an ordinary field value spelling "false" alone', function ( ) {
      find('find[madeUpField]=false').madeUpField.should.equal('false');
      find('find[madeUpField][$gte]=0').madeUpField.$gte.should.equal('0');
    });
  });
});
