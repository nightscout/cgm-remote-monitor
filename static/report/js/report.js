  'use strict';

  var translate = Nightscout.language.translate;
  
  var maxInsulinValue = 0
      ,maxCarbsValue = 0;
  var containerprefix = 'chart-';
  var maxdays = 3 * 31;
  var datastorage = {};
  var daystoshow = {};
  
  var targetBGdefault = {
    "mg/dl": { low: 72, high: 180 },
    "mmol": { low: 4, high: 10 }
  };
  
  var 
      ONE_MIN_IN_MS = 60000
    , SIX_MINS_IN_MS =  360000;

  var 
      SCALE_LINEAR = 0
    , SCALE_LOG = 1;
  
    
  var categories = [];
  var foodlist = [];
  


  function rawIsigToRawBg(entry, cal) {
    var raw = 0
      , unfiltered = parseInt(entry.unfiltered) || 0
      , filtered = parseInt(entry.filtered) || 0
      , sgv = entry.y
      , scale = parseFloat(cal.scale) || 0
      , intercept = parseFloat(cal.intercept) || 0
      , slope = parseFloat(cal.slope) || 0;

    if (slope == 0 || unfiltered == 0 || scale == 0) {
      raw = 0;
    } else if (filtered == 0 || sgv < 40) {
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

    $('#info').html('<b>'+translate('Loading profile')+' ...</b>');
    $.ajax('/api/v1/profile', {
      success: function (record) {
        Nightscout.profile.loadData(record);
      }
    }).done(function() {
      $('#info').html('<b>'+translate('Loading food database')+' ...</b>');
      $.ajax('/api/v1/food/regular.json', {
        success: function (records) {
          records.forEach(function (r) {
            foodlist.push(r);
            if (r.category && !categories[r.category]) categories[r.category] = {};
            if (r.category && r.subcategory) categories[r.category][r.subcategory] = true;
          });
          fillForm();
        }
      }).done(function() {
        $('#info').html('');
        $('.presetdates').click(function(e) { var days = $(this).attr('days');  setDataRange(e,days); });

        $('#rp_show').click(show);
        $('#rp_food').change(function (event) { 
          event.preventDefault(); 
          $('#rp_enablefood').prop('checked',true);
        });
        $('#rp_notes').change(function (event) { 
          event.preventDefault(); 
          $('#rp_enablenotes').prop('checked',true);
        });
        
        $('#rp_targetlow').val(targetBGdefault[serverSettings.units].low);
        $('#rp_targethigh').val(targetBGdefault[serverSettings.units].high);
        
        $('.menutab').click(switchtab);

        setDataRange(null,7);
        
        });
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
      scale: SCALE_LINEAR
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
    options.scale = $('#rp_linear').is(':checked') ? SCALE_LINEAR : SCALE_LOG;
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
          if (daystoshow[from.format('YYYY-MM-DD')]) daystoshow[from.format('YYYY-MM-DD')]++;
          else daystoshow[from.format('YYYY-MM-DD')] = 1;
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
            if (daystoshow[treatmentData[d]]) daystoshow[treatmentData[d]]++;
            else daystoshow[treatmentData[d]] = 1;
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
              if (daystoshow[treatmentData[d]]) daystoshow[treatmentData[d]]++;
              else daystoshow[treatmentData[d]] = 1;
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
              if (daystoshow[treatmentData[d]]) daystoshow[treatmentData[d]]++;
              else daystoshow[treatmentData[d]] = 1;
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
        if (day==0 && $('#rp_su').is(':checked')) daystoshow[d]++;
        if (day==1 && $('#rp_mo').is(':checked')) daystoshow[d]++;
        if (day==2 && $('#rp_tu').is(':checked')) daystoshow[d]++;
        if (day==3 && $('#rp_we').is(':checked')) daystoshow[d]++;
        if (day==4 && $('#rp_th').is(':checked')) daystoshow[d]++;
        if (day==5 && $('#rp_fr').is(':checked')) daystoshow[d]++;
        if (day==6 && $('#rp_sa').is(':checked')) daystoshow[d]++;
      }
      display();
    }
    
    function display() {
      console.log('Total: ',daystoshow,'Needed: ',matchesneeded);
      var displayeddays = 0;
      $('#info').html('<b>'+translate('Loading')+' ...</b>');
      $('#charts').html('');
      for (var d in daystoshow) {
        if (daystoshow[d]==matchesneeded) {
          if (displayeddays < maxdays) {
            $('#charts').append($('<div id="chart-'+d+'"></div>'));
            loadData(d,options);
            displayeddays++;
          } else {
            $('#charts').append($('<div>'+d+' '+translate('not displayed')+'.</div>'));
          }
        } else {
          delete daystoshow[d];
        }
      }
      if (displayeddays==0) {
        $('#charts').html('<b>'+translate('Result is empty')+'</b>');
        $('#info').empty();
      }
    }
    
    $('#rp_show').css('display','none');
    daystoshow = {};
    datefilter();
    if (event) event.preventDefault();
  }
  
  function showreports(options) {
    // wait for all loads
    for (var d in daystoshow) {
      if (!datastorage[d]) return; // all data not loaded yet
    }

    ['daytoday','dailystats','percentile','glucosedistribution','hourlystats','success','treatments','calibrations'].forEach(function (chart) {
      // jquery plot doesn't draw to hidden div
      $('#'+chart+'-placeholder').css('display','');
      eval('report_'+chart+'(datastorage,daystoshow,options);');
      if (!$('#'+chart).hasClass('selected'))
        $('#'+chart+'-placeholder').css('display','none');
    });
    
    $('#info').html('');
    $('#rp_show').css('display','');
  }

  function setDataRange(event,days) {
    $('#rp_to').val(moment().format('YYYY-MM-DD'));
    $('#rp_from').val(moment().add(-days+1, 'days').format('YYYY-MM-DD'));
    
    if (event) event.preventDefault();
  }
  
  function switchtab(event) {
    var id = $(this).attr('id');
    
    $('.menutab').removeClass('selected');
    $('#'+id).addClass('selected');
    
    $('.tabplaceholder').css('display','none');
    $('#'+id+'-placeholder').css('display','');
  
  }
  
  function localeDate(day) {
    var ret = 
      [translate("Sunday"),translate("Monday"),translate("Tuesday"),translate("Wednesday"),translate("Thursday"),translate("Friday"),translate("Saturday")][new Date(day).getDay()];
    ret += ' ';
    ret += new Date(day).toLocaleDateString();
    return ret;
  }
  
  function localeDateTime(day) {
    var ret = new Date(day).toLocaleDateString() + ' ' + new Date(day).toLocaleTimeString();
    return ret;
  }
  
  function loadData(day,options) {
    // check for loaded data
    if (datastorage[day] && day != moment().format('YYYY-MM-DD')) {
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
    
    $('#'+containerprefix+day).html('<b>'+translate('Loading CGM data of')+' '+day+' ...</b>');
    $.ajax('/api/v1/entries.json'+query, {
      success: function (xhr) {
        xhr.forEach(function (element) {
          if (element) {
            if (element.mbg) {
              mbgData.push({
                y: element.mbg
                , x: element.date
                , d: element.dateString
                , device: element.device
              });
            } else if (element.sgv) {
              cgmData.push({
                y: element.sgv
                , x: element.date
                , d: element.dateString
                , device: element.device
                , filtered: element.filtered
                , unfiltered: element.unfiltered
                , noise: element.noise
                , rssi: element.rssi
                , sgv: element.sgv
              });
            } else if (element.type == 'cal') {
              calData.push({
                x: element.date
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
        data.sgv.sort(function(a, b) { return a.x - b.x; });
        var lastDate = 0;
        data.sgv = data.sgv.filter(function(d) {
          var ok = (lastDate + ONE_MIN_IN_MS) < d.x;
          lastDate = d.x;
          return ok;
        });
        data.mbg = mbgData.slice();
        data.mbg.sort(function(a, b) { return a.x - b.x; });
        data.cal = calData.slice();
        data.cal.sort(function(a, b) { return a.x - b.x; });
      }
    }).done(function () {
      $('#'+containerprefix+day).html('<b>'+translate('Loading treatments data of')+' '+day+' ...</b>');
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
        $('#'+containerprefix+day).html('<b>'+translate('Processing data of')+' '+day+' ...</b>');
        processData(data,day,options);
      });
        
    });
  }

  function processData(data,day,options) {
    // treatments
    data.treatments.forEach(function (d) {
      if (parseFloat(d.insulin) > maxInsulinValue) maxInsulinValue = parseFloat(d.insulin);
      if (parseFloat(d.carbs) > maxCarbsValue) maxCarbsValue = parseFloat(d.carbs);
    });

    var cal = data.cal[data.cal.length-1];
    var temp1 = [ ];
    if (cal) {
      temp1 = data.sgv.map(function (entry) {
        var noise = entry.noise || 0;
        var rawBg = rawIsigToRawBg(entry, cal);
        return { x: entry.x, date: new Date(entry.x - 2 * 1000), y: rawBg, sgv: scaleBg(rawBg), color: 'gray', type: 'rawbg', filtered: entry.filtered, unfiltered: entry.unfiltered }
      }).filter(function(entry) { return entry.y > 0});
    }
    var temp2 = data.sgv.map(function (obj) {
      return { x: obj.x, date: new Date(obj.x), y: obj.y, sgv: scaleBg(obj.y), color: sgvToColor(scaleBg(obj.y),options), type: 'sgv', noise: obj.noise, filtered: obj.filtered, unfiltered: obj.unfiltered}
    });
    data.sgv = [].concat(temp1, temp2);

    //Add MBG's also, pretend they are SGV's
    data.sgv = data.sgv.concat(data.mbg.map(function (obj) { return { date: new Date(obj.x), y: obj.y, sgv: scaleBg(obj.y), color: 'red', type: 'mbg', device: obj.device } }));

    // make sure data range will be exactly 24h
    var from = new Date(new Date(day).getTime() + (new Date().getTimezoneOffset()*60*1000));
    var to = new Date(from.getTime() + 1000 * 60 * 60 * 24);
    data.sgv.push({ date: from, y: 40, sgv: 40, color: 'transparent', type: 'rawbg'});
    data.sgv.push({ date: to, y: 40, sgv: 40, color: 'transparent', type: 'rawbg'});

    // clear error data. we don't need it to display them
    data.sgv = data.sgv.filter(function (d) {
      if (d.y < 39) return false;
      return true;
    });
    
    //delete data.cal;
    //delete data.mbg;
    
    // for other reports
    data.statsrecords = data.sgv.filter(function(r) {
      if (r.type) return r.type == 'sgv';
      else return true;
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

  // Filtering food code
  // -------------------
  var categories = [];
  var foodlist = [];
  var filter = {
      category: ''
    , subcategory: ''
    , name: ''
  };

  function fillForm(event) {
    $('#rp_category').empty().append(new Option(translate('(none)'),''));
    for (var s in categories) {
      $('#rp_category').append(new Option(s,s));
    }
    filter.category = '';
    fillSubcategories();
    
    $('#rp_category').change(fillSubcategories);
    $('#rp_subcategory').change(doFilter);
    $('#rp_name').on('input',doFilter);
  
    if (event) event.preventDefault();
    return false;
  }

  function fillSubcategories(event) {
    if (event) {
      event.preventDefault();
    }
    filter.category = $('#rp_category').val();
    filter.subcategory = '';
    $('#rp_subcategory').empty().append(new Option(translate('(none)'),''));
    if (filter.category != '') {
      for (var s in categories[filter.category]) {
        $('#rp_subcategory').append(new Option(s,s));
      }
    }
    doFilter();
  }

  function doFilter(event) {
    if (event) {
      filter.category = $('#rp_category').val();
      filter.subcategory = $('#rp_subcategory').val();
      filter.name = $('#rp_name').val();
    }
    $('#rp_food').empty();
    for (var i=0; i<foodlist.length; i++) {
      if (filter.category != '' && foodlist[i].category != filter.category) continue;
      if (filter.subcategory != '' && foodlist[i].subcategory != filter.subcategory) continue;
      if (filter.name!= '' && foodlist[i].name.toLowerCase().indexOf(filter.name.toLowerCase())<0) continue;
      var o = '';
      o += foodlist[i].name + ' | ';
      o += translate('Portion')+': ' + foodlist[i].portion + ' ';
      o += foodlist[i].unit + ' | ';
      o += translate('Carbs')+': ' + foodlist[i].carbs+' g';
      $('#rp_food').append(new Option(o,foodlist[i]._id));
    }
    
    if (event) event.preventDefault();
  }
  
    function scaledTreatmentBG(treatment,data) {

      var SIX_MINS_IN_MS =  360000;
     
      function calcBGByTime(time) {
        var closeBGs = data.filter(function(d) {
          if (!d.y) {
            return false;
          } else {
            return Math.abs((new Date(d.date)).getTime() - time) <= SIX_MINS_IN_MS;
          }
        });

        var totalBG = 0;
        closeBGs.forEach(function(d) {
          totalBG += Number(d.y);
        });

        return totalBG > 0 ? (totalBG / closeBGs.length) : 450;
      }

      var treatmentGlucose = null;

      if (treatment.glucose && isNaN(treatment.glucose)) {
        console.warn('found an invalid glucose value', treatment);
      } else {
        if (treatment.glucose && treatment.units && serverSettings.units) {
          if (treatment.units != serverSettings.units) {
            console.info('found mismatched glucose units, converting ' + treatment.units + ' into ' + serverSettings.units, treatment);
            if (treatment.units == 'mmol') {
              //BG is in mmol and display in mg/dl
              treatmentGlucose = Math.round(treatment.glucose * 18)
            } else {
              //BG is in mg/dl and display in mmol
              treatmentGlucose = scaleBg(treatment.glucose);
            }
          } else {
            treatmentGlucose = treatment.glucose;
          }
        } else if (treatment.glucose) {
          //no units, assume everything is the same
          console.warn('found an glucose value with any units, maybe from an old version?', treatment);
          treatmentGlucose = treatment.glucose;
        }
      }

      return treatmentGlucose || scaleBg(calcBGByTime(treatment.mills));
    }

  function scaleBg(bg) {
    if (serverSettings.units === 'mmol') {
      return Nightscout.units.mgdlToMMOL(bg);
    } else {
      return bg;
    }
  }
