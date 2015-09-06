'use strict';

var should = require('should');

describe('Plugins', function ( ) {


  it('should find client plugins, but not server only plugins', function (done) {
    var plugins = require('../lib/plugins/')().registerClientDefaults();

    plugins('delta').name.should.equal('delta');
    plugins('rawbg').name.should.equal('rawbg');

    //server only plugin
    should.not.exist(plugins('treatmentnotify'));

    done( );
  });

  it('should find sever plugins, but not client only plugins', function (done) {
    var plugins = require('../lib/plugins/')().registerServerDefaults();

    plugins('rawbg').name.should.equal('rawbg');
    plugins('treatmentnotify').name.should.equal('treatmentnotify');

    //client only plugin
    should.not.exist(plugins('cannulaage'));

    done( );
  });


});
