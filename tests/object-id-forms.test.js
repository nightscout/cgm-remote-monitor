'use strict';

// lib/server/object-id-forms.js: the one rule for a 24-hex `_id`.
// No database: these are the values the storage modules query and write with.

require('should');
var ObjectID = require('mongodb').ObjectId;
var forms = require('../lib/server/object-id-forms');

describe('object-id-forms', function () {
  var HEX = '5f1f00000000000000000a01';
  var UPPER = '5F1F00000000000000000A0B';

  function kinds (list) {
    return list.map(function (v) { return v instanceof ObjectID ? 'ObjectId:' + v.toHexString() : typeof v + ':' + v; });
  }

  describe('isHexId', function () {
    it('accepts 24-hex strings in either case', function () {
      forms.isHexId(HEX).should.equal(true);
      forms.isHexId(UPPER).should.equal(true);
    });

    it('refuses everything else', function () {
      [undefined, null, '', 'abc', HEX + '0', HEX.slice(1), 'zf1f00000000000000000a01'
        , '0b8a2d4e-6f10-4c3a-9b7e-5d2f1a0c3e47', 12345, new ObjectID(HEX), { $ne: null }, [HEX]]
        .forEach(function (v) {
          forms.isHexId(v).should.equal(false, 'isHexId(' + String(v) + ')');
        });
    });

    it('exports the same pattern it tests with', function () {
      forms.OBJECT_ID_HEX_RE.test(HEX).should.equal(true);
      forms.OBJECT_ID_HEX_RE.test('0b8a2d4e-6f10-4c3a-9b7e-5d2f1a0c3e47').should.equal(false);
    });
  });

  describe('toStoredId', function () {
    it('turns a 24-hex string into the ObjectId it names', function () {
      var stored = forms.toStoredId(HEX);
      (stored instanceof ObjectID).should.equal(true);
      stored.toHexString().should.equal(HEX);
      forms.toStoredId(UPPER).toHexString().should.equal(UPPER.toLowerCase());
    });

    it('keeps any other value exactly as given', function () {
      var oid = new ObjectID(HEX);
      forms.toStoredId(oid).should.equal(oid);
      forms.toStoredId('0b8a2d4e-6f10-4c3a-9b7e-5d2f1a0c3e47').should.equal('0b8a2d4e-6f10-4c3a-9b7e-5d2f1a0c3e47');
      (forms.toStoredId(undefined) === undefined).should.equal(true);
      (forms.toStoredId(null) === null).should.equal(true);
    });
  });

  describe('idForms', function () {
    it('gives the ObjectId and the lower-case string for a lower-case hex id', function () {
      kinds(forms.idForms(HEX)).should.eql(['ObjectId:' + HEX, 'string:' + HEX]);
    });

    it('also gives the string as given for an upper-case hex id', function () {
      var lower = UPPER.toLowerCase();
      kinds(forms.idForms(UPPER)).should.eql(['ObjectId:' + lower, 'string:' + lower, 'string:' + UPPER]);
    });

    it('gives both forms for an ObjectId', function () {
      kinds(forms.idForms(new ObjectID(HEX))).should.eql(['ObjectId:' + HEX, 'string:' + HEX]);
    });

    it('throws for a value that is not an id', function () {
      (function () { forms.idForms('not-an-id'); }).should.throw();
    });

    it('throws for a 12-character string, which new ObjectId reads as raw bytes', function () {
      (function () { forms.idForms('abcdefghijkl'); }).should.throw();
    });

    it('stringIdForms keeps only the strings', function () {
      forms.stringIdForms(UPPER).should.eql([UPPER.toLowerCase(), UPPER]);
    });
  });

  describe('idFilter', function () {
    it('matches every form of a hex or ObjectId id', function () {
      kinds(forms.idFilter(UPPER).$in).should.eql(forms.idForms(UPPER).map(function (v) { return kinds([v])[0]; }));
      kinds(forms.idFilter(new ObjectID(HEX)).$in).should.eql(['ObjectId:' + HEX, 'string:' + HEX]);
    });

    it('matches any other value exactly as given', function () {
      forms.idFilter('abcdefghijkl').should.eql({ $eq: 'abcdefghijkl' });
      forms.idFilter('a-uuid-like-id').should.eql({ $eq: 'a-uuid-like-id' });
    });
  });

  describe('matchEitherForm', function () {
    it('widens an ObjectId equality to both forms, keeping the caller\'s own spelling', function () {
      var q = forms.matchEitherForm({ _id: new ObjectID(UPPER), type: 'sgv' }, UPPER);
      kinds(q._id.$in).should.eql(['ObjectId:' + UPPER.toLowerCase(), 'string:' + UPPER.toLowerCase(), 'string:' + UPPER]);
      q.type.should.equal('sgv');
    });

    it('uses the ObjectId when the caller\'s value is not a hex string', function () {
      var q = forms.matchEitherForm({ _id: new ObjectID(HEX) }, undefined);
      kinds(q._id.$in).should.eql(['ObjectId:' + HEX, 'string:' + HEX]);
    });

    it('leaves every other query alone', function () {
      var noId = { created_at: { $gte: '2021' } };
      forms.matchEitherForm(noId, undefined).should.eql({ created_at: { $gte: '2021' } });
      var inQuery = { _id: { $in: [new ObjectID(HEX)] } };
      forms.matchEitherForm(inQuery, undefined).should.equal(inQuery);
      inQuery._id.$in.length.should.equal(1);
      forms.matchEitherForm({ _id: 'uuid-like' }, 'uuid-like').should.eql({ _id: 'uuid-like' });
      var or = { $or: [{ identifier: 'x' }, { _id: 'x' }] };
      forms.matchEitherForm(or, 'x').should.equal(or);
      (forms.matchEitherForm(undefined, HEX) === undefined).should.equal(true);
    });
  });

  describe('staleStringForms and withStaleStringsRemoved', function () {
    it('lists the string forms of hex and ObjectId ids only', function () {
      forms.staleStringForms([HEX, new ObjectID(UPPER), undefined, null, '', 'a-uuid-like-id'])
        .should.eql([HEX, UPPER.toLowerCase()]);
    });

    it('appends one deleteMany after the upserts, only when there is something to delete', function () {
      var ops = [{ replaceOne: { filter: { _id: new ObjectID(HEX) } } }];
      forms.withStaleStringsRemoved(ops, [HEX]).should.equal(ops);
      ops.length.should.equal(2);
      ops[1].should.eql({ deleteMany: { filter: { _id: { $in: [HEX] } } } });

      var none = [{ insertOne: { document: {} } }];
      forms.withStaleStringsRemoved(none, [undefined, 'a-uuid-like-id']);
      none.length.should.equal(1);
    });
  });
});
