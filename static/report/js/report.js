// TODO:
// - bypass nightmode in reports
// - optimize .done() on food load
// - hiding food html
// - make axis on daytoday better working with thresholds
// - get rid of /static/report/js/time.js
// - load css dynamic + optimize
// - move rp_edittreatmentdialog html to plugin
// - check everything is translated
// - add tests
// - optimize merging data inside every plugin
// - auto check checkbox to enable filter when data changed
// - Insuling Change vs Insulin Cartridge Change in translations


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
  
  var translate = client.translate;
  
  var maxInsulinValue = 0
      ,maxCarbsValue = 0;
  var maxdays = 3 * 31;
  var datastorage = {};
  var daystoshow = {};
  
  var targetBGdefault = {
    'mg/dl': { low: 72, high: 180 },
    'mmol': { low: 4, high: 10 }
  };
  
  var ONE_MIN_IN_MS = 60000;

  // ****** FOOD CODE START ******
  var food_categories = [];
  var food_list = [];
  
  var filter = {
      category: ''
    , subcategory: ''
    , name: ''
  };

  function fillFoodForm(event) {
    $('#rp_category').empty().append(new Option(translate('(none)'),''));
    for (var s in food_categories) {
      $('#rp_category').append(new Option(s,s));
    }
    filter.category = '';
    fillFoodSubcategories();
    
    $('#rp_category').change(fillFoodSubcategories);
    $('#rp_subcategory').change(doFoodFilter);
    $('#rp_name').on('input',doFoodFilter);
  
    return maybePreventDefault(event);
  }

  function fillFoodSubcategories(event) {
    filter.category = $('#rp_category').val();
    filter.subcategory = '';
    $('#rp_subcategory').empty().append(new Option(translate('(none)'),''));
    if (filter.category !== '') {
      for (var s in food_categories[filter.category]) {
        $('#rp_subcategory').append(new Option(s,s));
      }
    }
    doFoodFilter();
    return maybePreventDefault(event);
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
      $('#rp_food').append(new Option(o,food_list[i]._id));
    }
    
    return maybePreventDefault(event);
  }

  // ****** FOOD CODE END ******


  function rawIsigToRawBg(entry, cal) {
    var raw = 0
      , unfiltered = parseInt(entry.unfiltered) || 0
      , filtered = parseInt(entry.filtered) || 0
      , sgv = entry.y
      , scale = parseFloat(cal.scale) || 0
      , intercept = parseFloat(cal.intercept) || 0
      , slope = parseFloat(cal.slope) || 0;

    if (slope === 0 || unfiltered === 0 || scale === 0) {
      raw = 0;
    } else if (filtered === 0 || sgv < 40) {
        raw = scale * (unfiltered - intercept) / slope;
    } else {
        var ratio = scale * (filtered - intercept) / slope / sgv;
        raw = scale * ( unfiltered - intercept) / slope / ratio;
    }
    return Math.round(raw);
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
    $('#info').html('');
    $('.presetdates').click(function(e) { var days = $(this).attr('days');  setDataRange(e,days); });

    $('#rp_show').click(show);
    $('#rp_food').change(function (event) { 
      $('#rp_enablefood').prop('checked',true);
      return maybePreventDefault(event);
    });
    $('#rp_notes').change(function (event) {
      $('#rp_enablenotes').prop('checked',true);
      return maybePreventDefault(event);
    });
    
    $('#rp_targetlow').val(targetBGdefault[client.settings.units].low);
    $('#rp_targethigh').val(targetBGdefault[client.settings.units].high);
    
    $('.menutab').click(switchreport_handler);

    setDataRange(null,7);
  }).fail(function() {
    $('#info').html('');
    $('.presetdates').click(function(e) { var days = $(this).attr('days');  setDataRange(e,days); });

    $('#rp_show').click(show);
    $('#rp_food').change(function (event) { 
      $('#rp_enablefood').prop('checked',true);
      return maybePreventDefault(event);
    });
    $('#rp_notes').change(function (event) { 
      $('#rp_enablenotes').prop('checked',true);
      return maybePreventDefault(event);
    });
    
    $('#rp_targetlow').val(targetBGdefault[client.settings.units].low);
    $('#rp_targethigh').val(targetBGdefault[client.settings.units].high);
    
    $('.menutab').click(switchreport_handler);

    setDataRange(null,7);
  });

  function show(event) {
    var options = {
      width: 1000,
      height: 300,
      targetLow: 3.5,
      targetHigh: 10,
      raw: true,
      notes: true,
      food: true,
      insulin: true,
      carbs: true,
      iob : true,
      cob : true,
      scale: report_plugins.consts.SCALE_LINEAR
    };
    
    options.targetLow = parseFloat($('#rp_targetlow').val().replace(',','.'));
    options.targetHigh = parseFloat($('#rp_targethigh').val().replace(',','.'));
    options.raw = $('#rp_optionsraw').is(':checked');
    options.iob = $('#rp_optionsiob').is(':checked');
    options.cob = $('#rp_optionscob').is(':checked');
    options.notes = $('#rp_optionsnotes').is(':checked');
    options.food = $('#rp_optionsfood').is(':checked');
    options.insulin = $('#rp_optionsinsulin').is(':checked');
    options.carbs = $('#rp_optionscarbs').is(':checked');
    options.scale = ( $('#rp_linear').is(':checked') ? report_plugins.consts.SCALE_LINEAR : report_plugins.consts.SCALE_LOG );
    options.width = parseInt($('#rp_size :selected').attr('x'));
    options.height = parseInt($('#rp_size :selected').attr('y'));
    
    var matchesneeded = 0;

    // date range
    function datefilter() {
      if ($('#rp_enabledate').is(':checked')) {
        matchesneeded++;
        var from = moment($('#rp_from').val());
        var to = moment($('#rp_to').val());
        
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
          var tquery = '?find[boluscalc.foods._id]='+_id;
          $.ajax('/api/v1/treatments.json'+tquery, {
            success: function (xhr) {
              treatmentData = xhr.map(function (treatment) {
                return moment(treatment.mills).format('YYYY-MM-DD');
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
          var tquery = '?find[notes]=/'+notes+'/i';
          $.ajax('/api/v1/treatments.json'+tquery, {
            success: function (xhr) {
              treatmentData = xhr.map(function (treatment) {
                return moment(treatment.mills).format('YYYY-MM-DD');
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
          var tquery = '?find[eventType]=/'+eventtype+'/i';
          $.ajax('/api/v1/treatments.json'+tquery, {
            success: function (xhr) {
              treatmentData = xhr.map(function (treatment) {
                return moment(treatment.mills).format('YYYY-MM-DD');
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
      for (var d in daystoshow) {
        var day = new Date(d).getDay();
        if (day===0 && $('#rp_su').is(':checked')) { daystoshow[d]++; }
        if (day===1 && $('#rp_mo').is(':checked')) { daystoshow[d]++; }
        if (day===2 && $('#rp_tu').is(':checked')) { daystoshow[d]++; }
        if (day===3 && $('#rp_we').is(':checked')) { daystoshow[d]++; }
        if (day===4 && $('#rp_th').is(':checked')) { daystoshow[d]++; }
        if (day===5 && $('#rp_fr').is(':checked')) { daystoshow[d]++; }
        if (day===6 && $('#rp_sa').is(':checked')) { daystoshow[d]++; }
      }
      display();
    }
    
    function display() {
      console.log('Total: ',daystoshow,'Needed: ',matchesneeded);
      var displayeddays = 0;
      $('#info').html('<b>'+translate('Loading')+' ...</b>');
      for (var d in daystoshow) {
        if (daystoshow[d]===matchesneeded) {
          if (displayeddays < maxdays) {
            $('#info').append($('<div id="info-' + d + '"></div>'));
            loadData(d,options);
            displayeddays++;
          } else {
            $('#info').append($('<div>'+d+' '+translate('not displayed')+'.</div>'));
          }
        } else {
          delete daystoshow[d];
        }
      }
      if (displayeddays===0) {
        $('#info').html('<b>'+translate('Result is empty')+'</b>');
      }
    }
    
    $('#rp_show').css('display','none');
    daystoshow = {};
    datefilter();
    return maybePreventDefault(event);
  }
  
  function showreports(options) {
    // wait for all loads
    for (var d in daystoshow) {
      if (!datastorage[d]) {
        return; // all data not loaded yet
      }
    }
    report_plugins.eachPlugin(function (plugin) {
      // jquery plot doesn't draw to hidden div
      $('#'+plugin.name+'-placeholder').css('display','');
      plugin.report(datastorage,daystoshow,options);
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
    return maybePreventDefault(event);
  }
  
  function switchreport_handler(event) {
    var id = $(this).attr('id');
    
    $('.menutab').removeClass('selected');
    $('#'+id).addClass('selected');
    
    $('.tabplaceholder').css('display','none');
    $('#'+id+'-placeholder').css('display','');
    return maybePreventDefault(event);
  }
  
  function loadData(day,options) {
    // check for loaded data
    if (datastorage[day] && day !== moment().format('YYYY-MM-DD')) {
      showreports(options);
      return;
    }
    // patientData = [actual, predicted, mbg, treatment, cal, devicestatusData];
    var data = {};
    var cgmData = []
      , mbgData = []
      , treatmentData = []
      , calData = []
      ;
    var dt = new Date(day);
    var from = dt.getTime() + dt.getTimezoneOffset() * 60 * 1000;
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
        }
      }).done(function () {
        $('#info-' + day).html('<b>'+translate('Processing data of')+' '+day+' ...</b>');
        processData(data,day,options);
      });
        
    });
  }

  function processData(data,day,options) {
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
    if (cal) {
      temp1 = data.sgv.map(function (entry) {
        var rawBg = rawIsigToRawBg(entry, cal);
        return { mills: entry.mills, date: new Date(entry.mills - 2 * 1000), y: rawBg, sgv: client.utils.scaleMgdl(rawBg), color: 'gray', type: 'rawbg', filtered: entry.filtered, unfiltered: entry.unfiltered }
      }).filter(function(entry) { return entry.y > 0});
    }
    var temp2 = data.sgv.map(function (obj) {
      return { mills: obj.mills, date: new Date(obj.mills), y: obj.y, sgv: client.utils.scaleMgdl(obj.y), color: sgvToColor(client.utils.scaleMgdl(obj.y),options), type: 'sgv', noise: obj.noise, filtered: obj.filtered, unfiltered: obj.unfiltered}
    });
    data.sgv = [].concat(temp1, temp2);

    //Add MBG's also, pretend they are SGV's
    data.sgv = data.sgv.concat(data.mbg.map(function (obj) { return { date: new Date(obj.mills), y: obj.y, sgv: client.utils.scaleMgdl(obj.y), color: 'red', type: 'mbg', device: obj.device } }));

    // make sure data range will be exactly 24h
    var from = new Date(new Date(day).getTime() + (new Date().getTimezoneOffset()*60*1000));
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
    options.maxInsulinValue = maxInsulinValue;
    options.maxCarbsValue = maxCarbsValue;
    showreports(options);
  }

  function maybePreventDefault(event) {
    if (event) {
      event.preventDefault();
    }
    return false;
  }
})();