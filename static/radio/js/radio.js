window.Nightscout.client.init(function loaded() {
  /*
  Many thanks to @ps2, Pete Schwamb
  * https://gist.github.com/ps2/314145bb91fa720bba59cf58f7e9cad2
  2**((numOctaves/(maxBG-minBG))*(bg-minBG) + Math.log2(minFreq))
  */
  function convert (opts) {
    opts = opts || { };
    var octaves = opts.octaves || 9;
    var maxBG = opts.maxBG || 400;
    var minBG = opts.minBG || 40;
    var minFreq = opts.minFreq || 55;
    var x = minBG
      , y = minFreq
      , z = octaves/(maxBG - minBG)
      ;

    function freq (bg) {
      return Math.pow(2, (z* (bg - x ) ) + Math.log2(y)) ;
      // return Math.pow(2, (z* (bg + x ) ) + Math.log2(y)) ;
    }

    function invert (freq) {

      return ((Math.log2(freq) - Math.log2(y)) / z ) + x;
    }

    function api (glucose) {
      return freq(glucose);
    }

    api.invert = invert;
    api.freq = freq;
    return api;
  }



  function createLoop (synth, sgvs) {
    function callback (time, note) {
      console.log(time, note);
      synth.triggerAttackRelease(note, '16n',  time);
    }
    var seq = new Tone.Sequence(callback, sgvs, '16n');
    seq.loop = false;
    return seq;
  }

  function glucose (sgv) {
    if (sgv) {
      return parseInt(sgv.mgdl || sgv.sgv || sgv.glucose || 35);
    }

    return 20;
  }

  $(document).ready(function ( ) {
    console.log('OK');
    var converter = convert( );
    var synth = new Tone.PolySynth(16, Tone.MonoSynth);
    // default volume always makes my ears bleed
    synth.chain(new Tone.Volume(-26), Tone.Master);
    // synth.toMaster();
    Tone.Transport.timeSignature = [ 3, 2 ];
    Tone.Transport.bpm.value = 320;

    // function play_next (time) {
    //   var sgv = sgvs.shift( );
    //   console.log(sgv);
    //   if (!sgv) {
    //     loop.stop( );
    //   }
    //   if (sgv) {
    //     var freq = converter.freq(sgv.mgdl || 30);
    //     synth.triggerAttackRelease(parseInt(sgv.mgdl || sgv.sgv || sgv.glucose || 39) * 4, '8n', time);
    //   }
    // }

    // var loop = new Tone.Loop(play_next, '4n');
    var loop;
    function play_data ( ) {
      var sgvs = Nightscout.client.sbx.data.sgvs.slice( ).map(glucose).map(converter.freq);
      console.log('last two hours', sgvs.length);
      var new_loop = createLoop(synth, sgvs);
      if (loop) {
        loop.stop( );
        loop.dispose( );
        loop = null;
      }
      loop = new_loop;
      Nightscout.client.radio.loop = loop;
      loop.start( );
    }

    Nightscout.client.radio = {
      converter: converter
      , synth: synth
      , loop: loop
    };

    Nightscout.client.socket.on('dataUpdate', function ( ) {
      play_data( );
    });
    $('#again').on('click', function ( ) {
      play_data( );
    });
    Tone.Transport.start( );

  });
});