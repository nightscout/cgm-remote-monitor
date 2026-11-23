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
    // changes nothing.
    //
    // THIS TEST USED $not AND NO LONGER CAN. Its subject is the depth property,
    // and $not was the fixture that expressed it -- measured at the time:
    // {sgv: {$not: {$exists: "false"}}} returns the document that HAS sgv, the
    // inverse of the inverse of the request. The v1 operator allowlist (BF-04)
    // now refuses $not, so that shape cannot reach the reader at all and the
    // property is asserted through $and, which is allowed and is the same
    // claim. The refusal is asserted below rather than left silent, because a
    // deleted assertion and a deleted capability look identical afterwards.
    it('reads the operand at any depth, including inside a group', function ( ) {
      const out = find('find[$and][0][madeUpField][$exists]=false');
      out.$and[0].madeUpField.$exists.should.equal(false);
    });

    it('no longer accepts $not at all, which is where that depth case used to live', function ( ) {
      (function ( ) { find('find[madeUpField][$not][$exists]=false'); })
        .should.throw(/^Query operator \$not is not supported/);
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

    // $type kept its own test in tests/query.test.js, where its operand reader
    // is the subject. $text is gone from this list: the allowlist (BF-04)
    // refuses it, and it could never have worked on a field anyway -- MongoDB
    // answers "unknown operator: $text" outside the top level, and Nightscout
    // creates no text index for the top-level form to use.
    it('leaves $options alone', function ( ) {
      find('find[notes][$options]=i').notes.$options.should.equal('i');
    });

    it('no longer accepts $text, which used to sit in this list as a fixture', function ( ) {
      (function ( ) { find('find[notes][$text]=x'); })
        .should.throw(/^Query operator \$text is not supported/);
    });

    // A field value that happens to spell a boolean is a VALUE, not an
    // operand, and must not be converted.
    it('leaves an ordinary field value spelling "false" alone', function ( ) {
      find('find[madeUpField]=false').madeUpField.should.equal('false');
      find('find[madeUpField][$gte]=0').madeUpField.$gte.should.equal('0');
    });
  });
});
