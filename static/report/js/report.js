// TODO:
// - bypass nightmode in reports
// - on save/delete treatment ctx.bus.emit('data-received'); is not enough. we must add something like 'data-updated'

(function () {
  'use strict';
  //for the tests window isn't the global object
  var $ = window.$;
  var _ = window._;
  var moment = window.moment;
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var report_plugins = Nightscout.report_plugins;

  if (serverSettings === undefined) {
    console.error('server settings were not loaded, will not call init');
  } else {
    client.init(serverSettings, Nightscout.plugins);
  }
 
  // init HTML code
  report_plugins.addHtmlFromPlugins( client );
  // make show() accessible outside for treatments.js
  report_plugins.show = show;
  
  var translate = client.translate;
  
  var maxInsulinValue = 0
      ,maxCarbsValue = 0;
  var maxdays = 3 * 31;
  var datastorage = {};
  var daystoshow = {};
  var sorteddaystoshow = [];
  
  var targetBGdefault = {
    'mg/dl': {
      low: client.settings.thresholds.bgTargetBottom
      , high: client.settings.thresholds.bgTargetTop
    }
    , 'mmol': {
      low: client.utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)
      , high: client.utils.scaleMgdl(client.settings.thresholds.bgTargetTop)
    }
  };
  
  var ONE_MIN_IN_MS = 60000;
  
  prepareGUI();

  // ****** FOOD CODE START ******
  var food_categories = [];
  var food_list = [];
  
  var filter = {
      category: ''
    , subcategory: ''
    , name: ''
  };

  function fillFoodForm(event) {
    $('#rp_category').empty().append('<option value="">' + translate('(none)') + '</option>');
    Object.keys(food_categories).forEach(function eachCategory(s) {
      $('#rp_category').append('<option value="' + s + '">' + s + '</option>');
    });
    filter.category = '';
    fillFoodSubcategories();

    $('#rp_category').change(fillFoodSubcategories);
    $('#rp_subcategory').change(doFoodFilter);
    $('#rp_name').on('input',doFoodFilter);
  
    return maybePrevent(event);
  }

  function fillFoodSubcategories(event) {
    filter.category = $('#rp_category').val();
    filter.subcategory = '';
    $('#rp_subcategory').empty().append('<option value="">' + translate('(none)') + '</option>');
    if (filter.category !== '') {
      Object.keys(food_categories[filter.category]).forEach(function eachSubCategory(s) {
        $('#rp_subcategory').append('<option value="' + s + '">' + s + '</option>');
      });
    }
    doFoodFilter();
    return maybePrevent(event);
  }

  function doFoodFilter(event) {
    if (event) {
      filter.category = $('#rp_category').val();
      filter.subcategory = $('#rp_subcategory').val();
      filter.name = $('#rp_name').val();
    }
    $('#rp_food').empty();
    for (var i=0; i<food_list.length; i++) {
      if (filter.category !== '' && food_list[i].category !== filter.category) { continue; }
      if (filter.subcategory !== '' && food_list[i].subcategory !== filter.subcategory) { continue; }
      if (filter.name !== '' && food_list[i].name.toLowerCase().indexOf(filter.name.toLowerCase()) < 0) { continue; }
      var o = '';
      o += food_list[i].name + ' | ';
      o += translate('Portion')+': ' + food_list[i].portion + ' ';
      o += food_list[i].unit + ' | ';
      o += translate('Carbs')+': ' + food_list[i].carbs+' g';
      $('#rp_food').append('<option value="' + food_list[i]._id + '">' + o + '</option>');
    }
    
    return maybePrevent(event);
  }

  $('#info').html('<b>'+translate('Loading food database')+' ...</b>');
  $.ajax('/api/v1/food/regular.json', {
    success: function foodLoadSuccess(records) {
      records.forEach(function (r) {
        food_list.push(r);
        if (r.category && !food_categories[r.category]) { food_categories[r.category] = {}; }
        if (r.category && r.subcategory) { food_categories[r.category][r.subcategory] = true; }
      });
      fillFoodForm();
    }
  }).done(function() {
    if (food_list.length) {
      enableFoodGUI();
    } else {
      disableFoodGUI();
    }
  }).fail(function() {
    disableFoodGUI();
  });

  function enableFoodGUI( ) {
    $('#info').html('');

    $('.rp_foodgui').css('display','');
    $('#rp_food').change(function (event) { 
      $('#rp_enablefood').prop('checked',true);
      return maybePrevent(event);
    });
  }
  
  function disableFoodGUI(){
    $('#info').html('');
    $('.rp_foodgui').css('display','none');
  }
  
  // ****** FOOD CODE END ******

  function prepareGUI() {
    $('.presetdates').click(function(event) { 
      var days = $(this).attr('days');
      $('#rp_enabledate').prop('checked',true);
      return setDataRange(event,days);
    });
    $('#rp_show').click(show);
    $('#rp_notes').bind('input', function (event) {
      $('#rp_enablenotes').prop('checked',true);
      return maybePrevent(event);
    });
    $('#rp_eventtype').bind('input', function (event) {
      $('#rp_enableeventtype').prop('checked',true);
      return maybePrevent(event);
    });
    
    // fill careportal events
    $('#rp_eventtype').empty();
    _.each(client.careportal.events, function eachEvent(event) {
      $('#rp_eventtype').append('<option value="' + event.val+ '">' + translate(event.name) + '</option>');
    });
    $('#rp_eventtype').append('<option value="sensor">' + '>>> ' + translate('All sensor events') + '</option>');
    
    $('#rp_targetlow').val(targetBGdefault[client.settings.units.toLowerCase()].low);
    $('#rp_targethigh').val(targetBGdefault[client.settings.units.toLowerCase()].high);

    if (client.settings.scaleY === 'linear') {
      $('#rp_linear').prop('checked', true);
    } else {
      $('#rp_log').prop('checked', true);
    }
    
    $('.menutab').click(switchreport_handler);

    setDataRange(null,7);
  }
  
  function sgvToColor(sgv,options) {
    var color = 'darkgreen';

    if (sgv > options.targetHigh) {
      color = 'red';
    } else if (sgv < options.targetLow) {
      color = 'red';
    }

    return color;
  }

  function show(event) {
    var options = {
      width: 1000
      , height: 300
      , targetLow: 3.5
      , targetHigh: 10
      , raw: true
      , notes: true
      , food: true
      , insulin: true
      , carbs: true
      , iob : true
      , cob : true
      , basal : true
      , scale: report_plugins.consts.scaleYFromSettings(client)
      , units: client.settings.units
    };

    // default time range if no time range specified in GUI
    var zone = client.sbx.data.profile.getTimezone();
    var timerange = '&find[created_at][$gte]='+moment.tz('2000-01-01',zone).toISOString();
    //console.log(timerange,zone);    
    options.targetLow = parseFloat($('#rp_targetlow').val().replace(',','.'));
    options.targetHigh = parseFloat($('#rp_targethigh').val().replace(',','.'));
    options.raw = $('#rp_optionsraw').is(':checked');
    options.iob = $('#rp_optionsiob').is(':checked');
    options.cob = $('#rp_optionscob').is(':checked');
    options.basal = $('#rp_optionsbasal').is(':checked');
    options.notes = $('#rp_optionsnotes').is(':checked');
    options.food = $('#rp_optionsfood').is(':checked');
    options.insulin = $('#rp_optionsinsulin').is(':checked');
    options.carbs = $('#rp_optionscarbs').is(':checked');
    options.scale = ( $('#rp_linear').is(':checked') ? report_plugins.consts.SCALE_LINEAR : report_plugins.consts.SCALE_LOG );
    options.order = ( $('#rp_oldestontop').is(':checked') ? report_plugins.consts.ORDER_OLDESTONTOP : report_plugins.consts.ORDER_NEWESTONTOP );
    options.width = parseInt($('#rp_size :selected').attr('x'));
    options.height = parseInt($('#rp_size :selected').attr('y'));
    
    var matchesneeded = 0;

    // date range
    function datefilter() {
      if ($('#rp_enabledate').is(':checked')) {
        matchesneeded++;
        var from = moment.tz($('#rp_from').val().replace(/\//g,'-') + 'T00:00:00',zone);
        var to = moment.tz($('#rp_to').val().replace(/\//g,'-') + 'T23:59:59',zone);
        timerange = '&find[created_at][$gte]='+from.toISOString()+'&find[created_at][$lt]='+to.toISOString();
        //console.log($('#rp_from').val(),$('#rp_to').val(),zone,timerange);
        while (from <= to) {
          if (daystoshow[from.format('YYYY-MM-DD')]) { 
            daystoshow[from.format('YYYY-MM-DD')]++;
          } else {
            daystoshow[from.format('YYYY-MM-DD')] = 1;
          }
          from.add(1, 'days');
        }
      }
      console.log('Dayfilter: ',daystoshow);
      foodfilter();
    }

    //food filter
    function foodfilter() {
      if ($('#rp_enablefood').is(':checked')) {
        matchesneeded++;
        var _id = $('#rp_food').val();
        if (_id) {
          var treatmentData;
          var tquery = '?find[boluscalc.foods._id]=' + _id + timerange;
          $.ajax('/api/v1/treatments.json'+tquery, {
            success: function (xhr) {
              treatmentData = xhr.map(function (treatment) {
                return moment.tz(treatment.created_at,zone).format('YYYY-MM-DD');
              });
              // unique it
              treatmentData = $.grep(treatmentData, function(v, k){
                return $.inArray(v ,treatmentData) === k;
              });
              treatmentData.sort(function(a, b) { return a > b; });
            }
          }).done(function () {
          console.log('Foodfilter: ',treatmentData);
          for (var d=0; d<treatmentData.length; d++) {
            if (daystoshow[treatmentData[d]]) {
              daystoshow[treatmentData[d]]++;
            } else {
              daystoshow[treatmentData[d]] = 1;
            }
          }
          notesfilter();
          });
        }
      } else {
        notesfilter();
      }
    }
    
    //notes filter
    function notesfilter() {
      if ($('#rp_enablenotes').is(':checked')) {
        matchesneeded++;
        var notes = $('#rp_notes').val();
        if (notes) {
          var treatmentData;
          var tquery = '?find[notes]=/' + notes + '/i';
          $.ajax('/api/v1/treatments.json' + tquery + timerange, {
            success: function (xhr) {
              treatmentData = xhr.map(function (treatment) {
                return moment.tz(treatment.created_at,zone).format('YYYY-MM-DD');
              });
              // unique it
              treatmentData = $.grep(treatmentData, function(v, k){
                return $.inArray(v ,treatmentData) === k;
              });
              treatmentData.sort(function(a, b) { return a > b; });
            }
          }).done(function () {
            console.log('Notesfilter: ',treatmentData);
            for (var d=0; d<treatmentData.length; d++) {
              if (daystoshow[treatmentData[d]]) {
                daystoshow[treatmentData[d]]++;
              } else {
                daystoshow[treatmentData[d]] = 1;
              }
            }
            eventtypefilter();
          });
        }
      } else {
        eventtypefilter();
      }
    }
    
    //event type filter
    function eventtypefilter() {
      if ($('#rp_enableeventtype').is(':checked')) {
        matchesneeded++;
        var eventtype = $('#rp_eventtype').val();
        if (eventtype) {
          var treatmentData;
          var tquery = '?find[eventType]=/' + eventtype + '/i';
          $.ajax('/api/v1/treatments.json' + tquery + timerange, {
            success: function (xhr) {
              treatmentData = xhr.map(function (treatment) {
                return moment.tz(treatment.created_at,zone).format('YYYY-MM-DD');
              });
              // unique it
              treatmentData = $.grep(treatmentData, function(v, k){
                return $.inArray(v ,treatmentData) === k;
              });
              treatmentData.sort(function(a, b) { return a > b; });
            }
          }).done(function () {
            console.log('Eventtypefilter: ',treatmentData);
            for (var d=0; d<treatmentData.length; d++) {
              if (daystoshow[treatmentData[d]]) {
                daystoshow[treatmentData[d]]++;
              } else {
                daystoshow[treatmentData[d]] = 1;
              }
            }
            daysfilter();
          });
        }
      } else {
        daysfilter();
      }
    }
    
    function daysfilter() {
      matchesneeded++;
      Object.keys(daystoshow).forEach( function eachDay(d) {
        var day = moment.tz(d,zone).day();
        if (day===0 && $('#rp_su').is(':checked')) { daystoshow[d]++; }
        if (day===1 && $('#rp_mo').is(':checked')) { daystoshow[d]++; }
        if (day===2 && $('#rp_tu').is(':checked')) { daystoshow[d]++; }
        if (day===3 && $('#rp_we').is(':checked')) { daystoshow[d]++; }
        if (day===4 && $('#rp_th').is(':checked')) { daystoshow[d]++; }
        if (day===5 && $('#rp_fr').is(':checked')) { daystoshow[d]++; }
        if (day===6 && $('#rp_sa').is(':checked')) { daystoshow[d]++; }
      });
      countDays();
      display();
    }
    
    function display() {
      var count = 0;
      sorteddaystoshow = [];
      $('#info').html('<b>'+translate('Loading')+' ...</b>');
      for (var d in daystoshow) {
        if (daystoshow[d]===matchesneeded) {
          if (count < maxdays) {
            $('#info').append($('<div id="info-' + d + '"></div>'));
            count++;
            loadData(d, options, dataLoadedCallback);
          } else {
            $('#info').append($('<div>'+d+' '+translate('not displayed')+'.</div>'));
            delete daystoshow[d];
          }
        } else {
          delete daystoshow[d];
        }
      }
      if (count===0) {
        $('#info').html('<b>'+translate('Result is empty')+'</b>');
        $('#rp_show').css('display','');
      }
    }
    
    var dayscount = 0;
    var loadeddays = 0;
    
    function countDays() {
      for (var d in daystoshow) {
        if (daystoshow.hasOwnProperty(d)) {
          if (daystoshow[d]===matchesneeded) {
            if (dayscount < maxdays) {
              dayscount++;
            }
          }
        }
      }
      console.log('Total: ', daystoshow, 'Matches needed: ', matchesneeded, 'Will be loaded: ', dayscount);
   }
    
    function dataLoadedCallback (day) {
      loadeddays++;
      sorteddaystoshow.push(day);
      if (loadeddays === dayscount) {
        sorteddaystoshow.sort();
        var from = sorteddaystoshow[0];
        if (options.order === report_plugins.consts.ORDER_NEWESTONTOP) {
          sorteddaystoshow.reverse();
        }
        loadTempBasals(from, function showreportscallback() { showreports(options); });
      }
    }
    
    $('#rp_show').css('display','none');
    daystoshow = {};

    datefilter();
    return maybePrevent(event);
  }
  
  function showreports(options) {
    // prepare some data used in more reports
    datastorage.allstatsrecords = [];
    datastorage.alldays = 0;
    sorteddaystoshow.forEach(function eachDay(day) {
      datastorage.allstatsrecords = datastorage.allstatsrecords.concat(datastorage[day].statsrecords);
      datastorage.alldays++;
    });
    options.maxInsulinValue = maxInsulinValue;
    options.maxCarbsValue = maxCarbsValue;

    datastorage.treatments = [];
    datastorage.combobolusTreatments = [];
    Object.keys(daystoshow).forEach( function eachDay(day) {
      datastorage.treatments = datastorage.treatments.concat(datastorage[day].treatments);
      datastorage.combobolusTreatments = datastorage.combobolusTreatments.concat(datastorage[day].combobolusTreatments);
    });
    
    report_plugins.eachPlugin(function (plugin) {
      // jquery plot doesn't draw to hidden div
      $('#'+plugin.name+'-placeholder').css('display','');
      //console.log('Drawing ',plugin.name);
      plugin.report(datastorage,sorteddaystoshow,options);
      if (!$('#'+plugin.name).hasClass('selected')) {
        $('#'+plugin.name+'-placeholder').css('display','none');
      }
    });
    
    $('#info').html('');
    $('#rp_show').css('display','');
  }

  function setDataRange(event,days) {
    $('#rp_to').val(moment().format('YYYY-MM-DD'));
    $('#rp_from').val(moment().add(-days+1, 'days').format('YYYY-MM-DD'));
    return maybePrevent(event);
  }
  
  function switchreport_handler(event) {
    var id = $(this).attr('id');
    
    $('.menutab').removeClass('selected');
    $('#'+id).addClass('selected');
    
    $('.tabplaceholder').css('display','none');
    $('#'+id+'-placeholder').css('display','');
    return maybePrevent(event);
  }
  
  function loadData(day, options, callback) {
    // check for loaded data
    if (datastorage[day] && day !== moment().format('YYYY-MM-DD')) {
      callback(day);
      return;
    }
    // patientData = [actual, predicted, mbg, treatment, cal, devicestatusData];
    var data = {};
    var cgmData = []
      , mbgData = []
      , treatmentData = []
      , calData = []
      ;
    var from;
    if (client.sbx.data.profile.getTimezone()) {
      from = moment(day).tz(client.sbx.data.profile.getTimezone()).startOf('day').format('x');
    } else {
      from = moment(day).startOf('day').format('x');
    }
    from = parseInt(from);
    var to = from + 1000 * 60 * 60 * 24;
    var query = '?find[date][$gte]='+from+'&find[date][$lt]='+to+'&count=10000';
    
    $('#info-' + day).html('<b>'+translate('Loading CGM data of')+' '+day+' ...</b>');
    $.ajax('/api/v1/entries.json'+query, {
      success: function (xhr) {
        xhr.forEach(function (element) {
          if (element) {
            if (element.mbg) {
              mbgData.push({
                y: element.mbg
                , mills: element.date
                , d: element.dateString
                , device: element.device
              });
            } else if (element.sgv) {
              cgmData.push({
                y: element.sgv
                , mills: element.date
                , d: element.dateString
                , device: element.device
                , filtered: element.filtered
                , unfiltered: element.unfiltered
                , noise: element.noise
                , rssi: element.rssi
                , sgv: element.sgv
              });
            } else if (element.type === 'cal') {
              calData.push({
                mills: element.date
                , d: element.dateString
                , scale: element.scale
                , intercept: element.intercept
                , slope: element.slope
              });
            }
          }
        });
         // sometimes cgm contains duplicates.  uniq it.
        data.sgv = cgmData.slice();
        data.sgv.sort(function(a, b) { return a.mills - b.mills; });
        var lastDate = 0;
        data.sgv = data.sgv.filter(function(d) {
          var ok = (lastDate + ONE_MIN_IN_MS) < d.mills;
          lastDate = d.mills;
          return ok;
        });
        data.mbg = mbgData.slice();
        data.mbg.sort(function(a, b) { return a.mills - b.mills; });
        data.cal = calData.slice();
        data.cal.sort(function(a, b) { return a.mills - b.mills; });
      }
    }).done(function () {
      $('#info-' + day).html('<b>'+translate('Loading treatments data of')+' '+day+' ...</b>');
      var tquery = '?find[created_at][$gte]='+new Date(from).toISOString()+'&find[created_at][$lt]='+new Date(to).toISOString();
      $.ajax('/api/v1/treatments.json'+tquery, {
        success: function (xhr) {
          treatmentData = xhr.map(function (treatment) {
            var timestamp = new Date(treatment.timestamp || treatment.created_at);
            treatment.mills = timestamp.getTime();
            return treatment;
          });
          data.treatments = treatmentData.slice();
          data.treatments.sort(function(a, b) { return a.mills - b.mills; });
          // filter & prepare 'Combo Bolus' events
          data.combobolusTreatments = data.treatments.filter( function filterComboBoluses(t) {
            return t.eventType === 'Combo Bolus';
          }).sort(function (a,b) { return a.mills > b.mills; });
        }
      }).done(function () {
        $('#info-' + day).html('<b>'+translate('Processing data of')+' '+day+' ...</b>');
        processData(data, day, options, callback);
      });
        
    });
  }

  function loadTempBasals(from, callback) {
    $('#info-' + from).html('<b>'+translate('Loading temp basal data') + ' ...</b>');
    var tquery = '?find[created_at][$gte]='+moment(from).subtract(32, 'days').toISOString()+'&find[eventType][$eq]=Temp Basal';
    $.ajax('/api/v1/treatments.json'+tquery, {
      success: function (xhr) {
        var treatmentData = xhr.map(function (treatment) {
          var timestamp = new Date(treatment.timestamp || treatment.created_at);
          treatment.mills = timestamp.getTime();
          return treatment;
        });
        datastorage.tempbasalTreatments = treatmentData.slice();
        datastorage.tempbasalTreatments.sort(function(a, b) { return a.mills - b.mills; });
      }
    }).done(function () {
      callback();
    });
  }
  
  function processData(data, day, options, callback) {
    // treatments
    data.treatments.forEach(function (d) {
      if (parseFloat(d.insulin) > maxInsulinValue) {
        maxInsulinValue = parseFloat(d.insulin);
      }
      if (parseFloat(d.carbs) > maxCarbsValue) {
        maxCarbsValue = parseFloat(d.carbs);
      }
    });

    var cal = data.cal[data.cal.length-1];
    var temp1 = [ ];
    var rawbg = Nightscout.plugins('rawbg');
    if (cal) {
      temp1 = data.sgv.map(function (entry) {
        entry.mgdl = entry.y; // value names changed from enchilada
        var rawBg = rawbg.calc(entry, cal);
        return { mills: entry.mills, date: new Date(entry.mills - 2 * 1000), y: rawBg, sgv: client.utils.scaleMgdl(rawBg), color: 'gray', type: 'rawbg', filtered: entry.filtered, unfiltered: entry.unfiltered };
      }).filter(function(entry) { return entry.y > 0});
    }
    var temp2 = data.sgv.map(function (obj) {
      return { mills: obj.mills, date: new Date(obj.mills), y: obj.y, sgv: client.utils.scaleMgdl(obj.y), color: sgvToColor(client.utils.scaleMgdl(obj.y),options), type: 'sgv', noise: obj.noise, filtered: obj.filtered, unfiltered: obj.unfiltered};
    });
    data.sgv = [].concat(temp1, temp2);

    //Add MBG's also, pretend they are SGV's
    data.sgv = data.sgv.concat(data.mbg.map(function (obj) { return { date: new Date(obj.mills), y: obj.y, sgv: client.utils.scaleMgdl(obj.y), color: 'red', type: 'mbg', device: obj.device } }));

    // make sure data range will be exactly 24h
    var from;
    if (client.sbx.data.profile.getTimezone()) {
      from = moment(day).tz(client.sbx.data.profile.getTimezone()).startOf('day').toDate();
    } else {
      from = moment(day).startOf('day').toDate();
    }
    var to = new Date(from.getTime() + 1000 * 60 * 60 * 24);
    data.sgv.push({ date: from, y: 40, sgv: 40, color: 'transparent', type: 'rawbg'});
    data.sgv.push({ date: to, y: 40, sgv: 40, color: 'transparent', type: 'rawbg'});

    // clear error data. we don't need it to display them
    data.sgv = data.sgv.filter(function (d) {
      if (d.y < 39) {
        return false;
      }
      return true;
    });
    
    // for other reports
    data.statsrecords = data.sgv.filter(function(r) {
      if (r.type) {
        return r.type === 'sgv';
      } else {
        return true;
      }
    }).map(function (r) { 
      var ret = {};
      ret.sgv = parseFloat(r.sgv); 
      ret.bgValue = parseInt(r.y);
      ret.displayTime = r.date;
      return ret;
    });

    
    datastorage[day] = data;
    callback(day);
  }

  function maybePrevent(event) {
    if (event) {
      event.preventDefault();
    }
    return false;
  }
})();