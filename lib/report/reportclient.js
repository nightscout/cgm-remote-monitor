const htmlUtils = require('../utils/html');

const init = function init () {
  'use strict';
  //for the tests window isn't the global object
  const $ = window.$;
  const Nightscout = window.Nightscout;
  const client = Nightscout.client;
  const report_plugins_preinit = Nightscout.report_plugins_preinit;
  let report_plugins;
  let guiReady = false;

  // Every socket connect authorizes and runs this callback, so page setup is
  // done on the first one and reconnects leave the GUI state as the user
  // left it.
  client.init(function loaded () {
    if (guiReady) {
      return;
    }
    guiReady = true;

    const moment = client.ctx.moment;

    report_plugins = report_plugins_preinit(client.ctx);
    Nightscout.report_plugins = report_plugins;

    // init HTML code
    report_plugins.addHtmlFromPlugins(client);
    // make show() accessible outside for treatments.js
    report_plugins.show = show;

    const translate = client.translate;

    let maxInsulinValue = 0
      , maxCarbsValue = 0
      , maxDailyCarbsValue = 0;
    const maxDays = 6 * 31;
    const datastorage = {};
    let daystoshow = {};
    let sorteddaystoshow = [];

    const targetBGdefault = {
      'mg/dl': {
        low: client.settings.thresholds.bgTargetBottom
        , high: client.settings.thresholds.bgTargetTop
      }
      , 'mmol': {
        low: client.utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)
        , high: client.utils.scaleMgdl(client.settings.thresholds.bgTargetTop)
      }
    };

    const uniqSgv = require('./uniqsgv');

    prepareGUI();

    // ****** FOOD CODE START ******
    const food_categories = Object.create(null);
    const food_list = [];

    const filter = {
      category: ''
      , subcategory: ''
      , name: ''
    };

    function fillFoodForm (event) {
      let category = $('#rp_category');

      category.empty().append($('<option>').val('').text(translate('(none)')));
      Object.keys(food_categories).forEach(function eachCategory (s) {
        category.append($('<option>').val(s).text(htmlUtils.toTextContent(s)));
      });
      filter.category = '';
      fillFoodSubcategories();

      category.change(fillFoodSubcategories);
      $('#rp_subcategory').change(doFoodFilter);
      $('#rp_name').on('input', doFoodFilter);

      return maybePrevent(event);
    }

    function fillFoodSubcategories (event) {
      filter.category = $('#rp_category').val();
      filter.subcategory = '';
      $('#rp_subcategory').empty().append($('<option>').val('').text(translate('(none)')));
      if (filter.category !== '') {
        Object.keys(food_categories[filter.category] || {}).forEach(function eachSubCategory (s) {
          $('#rp_subcategory').append($('<option>').val(s).text(htmlUtils.toTextContent(s)));
        });
      }
      doFoodFilter();
      return maybePrevent(event);
    }

    function doFoodFilter (event) {
      if (event) {
        filter.category = $('#rp_category').val();
        filter.subcategory = $('#rp_subcategory').val();
        filter.name = $('#rp_name').val();
      }
      let food = $('#rp_food');

      food.empty();
      for (let foodListElement of food_list) {
        if (filter.category !== '' && foodListElement.category !== filter.category) {
          continue;
        }
        if (filter.subcategory !== '' && foodListElement.subcategory !== filter.subcategory) {
          continue;
        }
        if (filter.name !== '' && foodListElement.name.toLowerCase().indexOf(filter.name.toLowerCase()) < 0) {
          continue;
        }
        let o = '';
        o += foodListElement.name + ' | ';
        o += translate('Portion') + ': ' + foodListElement.portion + ' ';
        o += foodListElement.unit + ' | ';
        o += translate('Carbs') + ': ' + foodListElement.carbs + ' g';
        food.append($('<option>').val(foodListElement._id).text(htmlUtils.toTextContent(o)));
      }

      return maybePrevent(event);
    }

    $('#info').html('<b>' + translate('Loading food database') + ' ...</b>');
    $.ajax('/api/v1/food/regular.json', {
      headers: client.headers()
      , success: function foodLoadSuccess (records) {
        records.forEach(function(r) {
          food_list.push(r);
          if (r.category && !Object.prototype.hasOwnProperty.call(food_categories, r.category)) {
            food_categories[r.category] = Object.create(null);
          }
          if (r.category && r.subcategory) {
            food_categories[r.category][r.subcategory] = true;
          }
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

    function enableFoodGUI () {
      $('#info').html('');

      $('.rp_foodgui').css('display', '');
      $('#rp_food').change(function(event) {
        $('#rp_enablefood').prop('checked', true);
        return maybePrevent(event);
      });
    }

    function disableFoodGUI () {
      $('#info').html('');
      $('.rp_foodgui').css('display', 'none');
    }

    // ****** FOOD CODE END ******

    function prepareGUI () {
      $('.presetdates').click(function(event) {
        const days = $(this).attr('days');
        $('#rp_enabledate').prop('checked', true);
        return setDataRange(event, days);
      });
      $('#rp_show').click(show);
      $('#rp_notes').bind('input', function(event) {
        $('#rp_enablenotes').prop('checked', true);
        return maybePrevent(event);
      });
      let eventType = $('#rp_eventtype');
      eventType.bind('input', function(event) {
        $('#rp_enableeventtype').prop('checked', true);
        return maybePrevent(event);
      });
      // fill careportal events
      eventType.empty();
      client.careportal.events?.forEach(function eachEvent (event) {
        eventType.append('<option value="' + event.val + '">' + translate(event.name) + '</option>');
      });
      eventType.append('<option value="sensor">' + '>>> ' + translate('All sensor events') + '</option>');

      $('#rp_targetlow').val(targetBGdefault[client.settings.units.toLowerCase()].low);
      $('#rp_targethigh').val(targetBGdefault[client.settings.units.toLowerCase()].high);

      if (client.settings.scaleY === 'linear') {
        $('#rp_linear').prop('checked', true);
        $('#wrp_linear').prop('checked', true);
      } else {
        $('#rp_log').prop('checked', true);
        $('#wrp_log').prop('checked', true);
      }

      $('.menutab').click(switchreport_handler);

      setDataRange(null, 7);
    }

    function sgvToColor (sgv, options) {
      let color = 'darkgreen';

      if (sgv > options.targetHigh) {
        color = 'red';
      } else if (sgv < options.targetLow) {
        color = 'red';
      }

      return color;
    }

    function show (event) {
      let dayscount;
      const options = {
        targetLow: 3.5
        , targetHigh: 10
        , raw: true
        , notes: true
        , food: true
        , insulin: true
        , carbs: true
        , iob: true
        , cob: true
        , basal: true
        , scale: report_plugins.consts.scaleYFromSettings(client)
        , weekscale: report_plugins.consts.scaleYFromSettings(client)
        , units: client.settings.units
      };

      // default time range if no time range specified in GUI
      const profile = client.sbx.data.profile;
      let timerange = '&find[created_at][$gte]=' + profile.parseInTimezone('2000-01-01').toISOString();
      //console.log(timerange, profile.getTimezone());
      options.targetLow = parseFloat($('#rp_targetlow').val().replace(',', '.'));
      options.targetHigh = parseFloat($('#rp_targethigh').val().replace(',', '.'));
      options.raw = $('#rp_optionsraw').is(':checked');
      options.iob = $('#rp_optionsiob').is(':checked');
      options.cob = $('#rp_optionscob').is(':checked');
      options.openAps = $('#rp_optionsopenaps').is(':checked');
      options.predicted = $('#rp_optionspredicted').is(':checked');
      options.predictedTruncate = $('#rp_optionsPredictedTruncate').is(':checked');
      options.basal = $('#rp_optionsbasal').is(':checked');
      options.notes = $('#rp_optionsnotes').is(':checked');
      options.food = $('#rp_optionsfood').is(':checked');
      options.insulin = $('#rp_optionsinsulin').is(':checked');
      options.insulindistribution = $('#rp_optionsdistribution').is(':checked');
      options.carbs = $('#rp_optionscarbs').is(':checked');
      options.scale = ($('#rp_linear').is(':checked') ? report_plugins.consts.SCALE_LINEAR : report_plugins.consts.SCALE_LOG);
      options.weekscale = ($('#wrp_linear').is(':checked') ? report_plugins.consts.SCALE_LINEAR : report_plugins.consts.SCALE_LOG);
      options.order = ($('#rp_oldestontop').is(':checked') ? report_plugins.consts.ORDER_OLDESTONTOP : report_plugins.consts.ORDER_NEWESTONTOP);
      options.loopalyzer = $("#loopalyzer").hasClass("selected"); // We only want to run through Loopalyzer if that tab is selected
      if (options.loopalyzer) {
        options.iob = true;
        options.cob = true;
        options.openAps = true;
      }
      options.bgcheck = $('#rp_optionsbgcheck').is(':checked');
      options.othertreatments = $('#rp_optionsothertreatments').is(':checked');

      const reportStorage = require('./reportstorage');
      reportStorage.saveProps(options);
      let matchesneeded = 0;

      // date range
      function datefilter () {
        if ($('#rp_enabledate').is(':checked')) {
          matchesneeded++;
          const from = profile.parseInTimezone($('#rp_from').val());
          const to = profile.parseInTimezone($('#rp_to').val()).endOf('day');
          timerange = '&find[created_at][$gte]=' + from.toISOString() + '&find[created_at][$lt]=' + to.toISOString();

          console.log("FROM", from.format(), "TO", to.format(), 'timerange', timerange);
          //console.log($('#rp_from').val(), $('#rp_to').val(), profile.getTimezone(), timerange);
          while (from <= to) {
            if (daystoshow[from.format('YYYY-MM-DD')]) {
              daystoshow[from.format('YYYY-MM-DD')]++;
            } else {
              daystoshow[from.format('YYYY-MM-DD')] = 1;
            }
            from.add(1, 'days');
          }
        }
        //console.log('Dayfilter: ',daystoshow);
        foodfilter();
      }

      //food filter
      function foodfilter () {
        if ($('#rp_enablefood').is(':checked')) {
          matchesneeded++;
          const _id = $('#rp_food').val();
          if (_id) {
            let treatmentData;
            const tquery = '?find[boluscalc.foods._id]=' + _id + timerange;
            $.ajax('/api/v1/treatments.json' + tquery, {
              headers: client.headers()
              , success: function(xhr) {
                treatmentData = xhr.map(function(treatment) {
                  return profile.applyTimezone(moment(treatment.created_at)).format('YYYY-MM-DD');
                });
                // unique it
                treatmentData = $.grep(treatmentData, function(v, k) {
                  return $.inArray(v, treatmentData) === k;
                });
                treatmentData.sort(function(a, b) {
                  return a > b;
                });
              }
            }).done(function() {
              //console.log('Foodfilter: ',treatmentData);
              for (const item of treatmentData) {
                if (daystoshow[item]) {
                  daystoshow[item]++;
                } else {
                  daystoshow[item] = 1;
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
      function notesfilter () {
        if ($('#rp_enablenotes').is(':checked')) {
          matchesneeded++;
          const notes = $('#rp_notes').val();
          if (notes) {
            let treatmentData;
            const tquery = '?find[notes]=/' + notes + '/i';
            $.ajax('/api/v1/treatments.json' + tquery + timerange, {
              headers: client.headers()
              , success: function(xhr) {
                treatmentData = xhr.map(function(treatment) {
                  return profile.applyTimezone(moment(treatment.created_at)).format('YYYY-MM-DD');
                });
                // unique it
                treatmentData = $.grep(treatmentData, function(v, k) {
                  return $.inArray(v, treatmentData) === k;
                });
                treatmentData.sort(function(a, b) {
                  return a > b;
                });
              }
            }).done(function() {
              //console.log('Notesfilter: ',treatmentData);
              for (const item of treatmentData) {
                if (daystoshow[item]) {
                  daystoshow[item]++;
                } else {
                  daystoshow[item] = 1;
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
      function eventtypefilter () {
        if ($('#rp_enableeventtype').is(':checked')) {
          matchesneeded++;
          const eventtype = $('#rp_eventtype').val();
          if (eventtype) {
            let treatmentData;
            const tquery = '?find[eventType]=/' + eventtype + '/i';
            $.ajax('/api/v1/treatments.json' + tquery + timerange, {
              headers: client.headers()
              , success: function(xhr) {
                treatmentData = xhr.map(function(treatment) {
                  return profile.applyTimezone(moment(treatment.created_at)).format('YYYY-MM-DD');
                });
                // unique it
                treatmentData = $.grep(treatmentData, function(v, k) {
                  return $.inArray(v, treatmentData) === k;
                });
                treatmentData.sort(function(a, b) {
                  return a > b;
                });
              }
            }).done(function() {
              //console.log('Eventtypefilter: ',treatmentData);
              for (const item of treatmentData) {
                if (daystoshow[item]) {
                  daystoshow[item]++;
                } else {
                  daystoshow[item] = 1;
                }
              }
              daysfilter();
            });
          }
        } else {
          daysfilter();
        }
      }

      function daysfilter () {
        matchesneeded++;
        Object.keys(daystoshow).forEach(function eachDay (d) {
          const day = profile.parseInTimezone(d).day();
          if (day === 0 && $('#rp_su').is(':checked')) {
            daystoshow[d]++;
          }
          if (day === 1 && $('#rp_mo').is(':checked')) {
            daystoshow[d]++;
          }
          if (day === 2 && $('#rp_tu').is(':checked')) {
            daystoshow[d]++;
          }
          if (day === 3 && $('#rp_we').is(':checked')) {
            daystoshow[d]++;
          }
          if (day === 4 && $('#rp_th').is(':checked')) {
            daystoshow[d]++;
          }
          if (day === 5 && $('#rp_fr').is(':checked')) {
            daystoshow[d]++;
          }
          if (day === 6 && $('#rp_sa').is(':checked')) {
            daystoshow[d]++;
          }
        });
        countDays();
        addPreviousDayTreatments();
        display();
      }

      let buttonShow = $('#rp_show');

      function display () {
        let count = 0;
        sorteddaystoshow = [];
        $('#info').html('<b>' + translate('Loading') + ' ...</b>');

        // Determine the final request count before starting any loads. Cached
        // data can call back synchronously, so the progress bar must exist first.
        for (const d in daystoshow) {
          if (count < maxDays) {
            count++;
          } else {
            delete daystoshow[d];
          }
        }
        if (count === 0) {
          // Nothing repaints the reports on this path, so the placeholders
          // stay hidden and the message is all that is on screen.
          $('#pluginchartplaceholders').css('display', 'none');
          $('#info').html('<b>' + translate('Result is empty') + '</b>');
          buttonShow.css('display', '');
          return;
        }

        dayscount = count;
        createProgressBar();
        for (const day in daystoshow) {
          if (Object.prototype.hasOwnProperty.call(daystoshow, day)) {
            loadData(day, options, dataLoadedCallback);
          }
        }
      }

      function createProgressBar () {
        const progressBar = $('<div id="report-progressbar"></div>');
        $('#info').append(progressBar);
        if (typeof progressBar.progressbar === 'function') {
          progressBar.progressbar({ value: 0 });
        } else {
          progressBar.attr({
              role: 'progressbar'
              , 'aria-valuemin': 0
              , 'aria-valuemax': 100
              , 'aria-valuenow': 0
            })
            .append($('<div>').addClass('report-progress-value'));
        }
      }

      function updateProgressBar (value) {
        const progressBar = $('#report-progressbar');
        if (typeof progressBar.progressbar === 'function') {
          progressBar.progressbar({ value: value });
        } else {
          progressBar.attr('aria-valuenow', value);
          progressBar.find('.report-progress-value').css('width', value + '%');
        }
      }

      dayscount = 0;
      let loadeddays = 0;

      function countDays () {
        for (const d in daystoshow) {
          if (Object.prototype.hasOwnProperty.call(daystoshow, d)) {
            if (daystoshow[d] === matchesneeded) {
              if (dayscount < maxDays) {
                dayscount++;
              }
            } else {
              delete daystoshow[d];
            }
          }
        }
        //console.log('Total: ', daystoshow, 'Matches needed: ', matchesneeded, 'Will be loaded: ', dayscount);
      }

      function addPreviousDayTreatments () {
        for (const d in daystoshow) {
          if (Object.prototype.hasOwnProperty.call(daystoshow, d)) {
            const day = profile.parseInTimezone(d);
            const previous = day.subtract(1, 'days');
            const formated = previous.format('YYYY-MM-DD');
            if (!daystoshow[formated]) {
              daystoshow[formated] = { treatmentsonly: true };
              console.log('Adding ' + formated + ' for loading treatments');
              dayscount++;
            }
          }
        }
        //console.log('Total: ', daystoshow, 'Matches needed: ', matchesneeded, 'Will be loaded: ', dayscount);
      }

      function dataLoadedCallback (day) {
        loadeddays++;
        updateProgressBar(dayscount > 0 ? Math.round(loadeddays / dayscount * 100) : 100);
        if (!daystoshow[day].treatmentsonly) {
          sorteddaystoshow.push(day);
        }
        if (loadeddays === dayscount) {
          sorteddaystoshow.sort();
          const dFrom = sorteddaystoshow[0];
          const dTo = sorteddaystoshow[(sorteddaystoshow.length - 1)];

          if (options.order === report_plugins.consts.ORDER_NEWESTONTOP) {
            sorteddaystoshow.reverse();
          }
          loadProfileSwitch(dFrom, function loadProfileSwitchCallback () {
            loadProfilesRange(dFrom, dTo, sorteddaystoshow.length, function loadProfilesCallback () {
              $('#info > b').html('<b>' + translate('Rendering') + ' ...</b>');
              window.setTimeout(function() {
                showreports(options);
              }, 0);
            });
          });
        }
      }

      buttonShow.css('display', 'none');
      daystoshow = {};

      datefilter();
      return maybePrevent(event);
    }

    function showreports (options) {
      $('#pluginchartplaceholders').css('display', '');

      // prepare some data used in more reports
      datastorage.allstatsrecords = [];
      datastorage.alldays = 0;
      sorteddaystoshow.forEach(function eachDay (day) {
        if (!daystoshow[day].treatmentsonly) {
          datastorage.allstatsrecords = datastorage.allstatsrecords.concat(datastorage[day].statsrecords);
          datastorage.alldays++;
        }
      });
      options.maxInsulinValue = maxInsulinValue;
      options.maxCarbsValue = maxCarbsValue;
      options.maxDailyCarbsValue = maxDailyCarbsValue;

      datastorage.treatments = [];
      datastorage.devicestatus = [];
      datastorage.combobolusTreatments = [];
      datastorage.tempbasalTreatments = [];
      Object.keys(daystoshow).forEach(function eachDay (day) {
        datastorage.treatments = datastorage.treatments.concat(datastorage[day].treatments);
        datastorage.devicestatus = datastorage.devicestatus.concat(datastorage[day].devicestatus);
        datastorage.combobolusTreatments = datastorage.combobolusTreatments.concat(datastorage[day].combobolusTreatments);
        datastorage.tempbasalTreatments = datastorage.tempbasalTreatments.concat(datastorage[day].tempbasalTreatments);
      });
      datastorage.tempbasalTreatments = Nightscout.client.ddata.processDurations(datastorage.tempbasalTreatments);
      datastorage.treatments.sort(function sort (a, b) {
        return a.mills - b.mills;
      });

      for (const d in daystoshow) {
        if (Object.prototype.hasOwnProperty.call(daystoshow, d)) {
          if (daystoshow[d].treatmentsonly) {
            delete daystoshow[d];
            delete datastorage[d];
          }
        }
      }

      report_plugins.eachPlugin(function(plugin) {
        const selected = $('#' + plugin.name).hasClass('selected');
        const placeholder = $('#' + plugin.name + '-placeholder');
        placeholder.toggleClass('is-hidden', !selected);

        if (!selected) {
          console.log('Skipping ', plugin.name);
          return;
        }

        // jquery plot doesn't draw to hidden div
        console.log('Drawing ', plugin.name, options);
        plugin.report(datastorage, sorteddaystoshow, options);
      });

      $('#info').html('');
      $('#rp_show').css('display', '');
    }

    function setDataRange (event, days) {
      $('#rp_to').val(moment().format('YYYY-MM-DD'));
      $('#rp_from').val(moment().add(-days + 1, 'days').format('YYYY-MM-DD'));
      return maybePrevent(event);
    }

    function switchreport_handler (event) {
      const id = $(this).attr('id');

      $('.menutab').removeClass('selected');
      $('#' + id).addClass('selected');

      $('.tabplaceholder').addClass('is-hidden');
      $('#' + id + '-placeholder').removeClass('is-hidden');
      return maybePrevent(event);
    }

    function loadData (day, options, callback) {
      // check for loaded data
      if ((options.openAps || options.predicted || options.iob || options.cob) && datastorage[day] && !datastorage[day].devicestatus.length) {
        // OpenAPS requested but data not loaded. Load anyway ...
      } else if (datastorage[day] && day !== moment().format('YYYY-MM-DD')) {
        callback(day);
        return;
      }
      // patientData = [actual, predicted, mbg, treatment, cal, devicestatusData];
      const data = {};
      let cgmData = []
        , mbgData = []
        , treatmentData = []
        , calData = [];
      let from = client.sbx.data.profile.parseInTimezone(day).format('x');
      from = parseInt(from);
      const to = from + 1000 * 60 * 60 * 24;

      function loadCGMData () {
        if (daystoshow[day].treatmentsonly) {
          data.sgv = [];
          data.mbg = [];
          data.cal = [];
          return $.Deferred().resolve();
        }
        const query = '?find[date][$gte]=' + from + '&find[date][$lt]=' + to + '&count=10000';
        return $.ajax('/api/v1/entries.json' + query, {
          headers: client.headers()
          , success: function(xhr) {
            xhr.forEach(function(element) {
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
                    mills: element.date + 1
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
            data.sgv.sort(function(a, b) {
              return a.mills - b.mills;
            });
            data.sgv = uniqSgv(data.sgv, function(d) {
              console.log("itm", JSON.stringify(d));
            });
            data.mbg = mbgData.slice();
            data.mbg.sort(function(a, b) {
              return a.mills - b.mills;
            });
            data.cal = calData.slice();
            data.cal.sort(function(a, b) {
              return a.mills - b.mills;
            });
          }
        });
      }

      function loadTreatmentData () {
        if (!datastorage.profileSwitchTreatments)
          datastorage.profileSwitchTreatments = [];
        const tquery = '?find[created_at][$gte]=' + new Date(from).toISOString() + '&find[created_at][$lt]=' + new Date(to).toISOString() + '&count=1000';
        return $.ajax('/api/v1/treatments.json' + tquery, {
          headers: client.headers()
          , cache: false
          , success: function(xhr) {
            treatmentData = xhr.map(function(treatment) {
              const timestamp = new Date(treatment.timestamp || treatment.created_at);
              treatment.mills = timestamp.getTime();
              return treatment;
            });
            data.treatments = treatmentData.slice();
            data.treatments.sort(function(a, b) {
              return a.mills - b.mills;
            });
            // filter 'Combo Bolus' events
            data.combobolusTreatments = data.treatments.filter(function filterComboBoluses (t) {
              return t.eventType === 'Combo Bolus';
            });
            // filter temp basal treatments
            data.tempbasalTreatments = data.treatments.filter(function filterTempBasals (t) {
              return t.eventType === 'Temp Basal';
            });
            // filter profile switch treatments
            const profileSwitch = data.treatments.filter(function filterProfileSwitch (t) {
              return t.eventType === 'Profile Switch';
            });
            datastorage.profileSwitchTreatments = datastorage.profileSwitchTreatments.concat(profileSwitch);
          }
        });
      }

      function loadDevicestatusData () {
        if (daystoshow[day].treatmentsonly) {
          data.devicestatus = [];
          return $.Deferred().resolve();
        }
        if (options.iob || options.cob || options.openAps || options.predicted) {
          const tquery = '?find[created_at][$gte]=' + new Date(from).toISOString() + '&find[created_at][$lt]=' + new Date(to).toISOString() + '&count=10000';
          return $.ajax('/api/v1/devicestatus.json' + tquery, {
            headers: client.headers()
            , success: function(xhr) {
              data.devicestatus = xhr.map(function(devicestatus) {
                devicestatus.mills = new Date(devicestatus.timestamp || devicestatus.created_at).getTime();
                return devicestatus;
              });
            }
          });
        } else {
          data.devicestatus = [];
          return $.Deferred().resolve();
        }
      }

      $.when(loadCGMData(), loadTreatmentData(), loadDevicestatusData()).done(function() {
        processData(data, day, options, callback);
      });
    }

    function loadProfileSwitch (from, callback) {
      $('#info > b').html('<b>' + translate('Loading profile switch data') + ' ...</b>');
      const tquery = '?find[eventType]=Profile Switch' + '&find[created_at][$lte]=' + new Date(from).toISOString() + '&count=1';
      $.ajax('/api/v1/treatments.json' + tquery, {
        headers: client.headers()
        , success: function(xhr) {
          const treatmentData = xhr.map(function(treatment) {
            const timestamp = new Date(treatment.timestamp || treatment.created_at);
            treatment.mills = timestamp.getTime();
            return treatment;
          });
          if (!datastorage.profileSwitchTreatments)
            datastorage.profileSwitchTreatments = [];
          datastorage.profileSwitchTreatments = datastorage.profileSwitchTreatments.concat(treatmentData);
          datastorage.profileSwitchTreatments.sort(function(a, b) {
            return a.mills - b.mills;
          });
        }
      }).done(function() {
        callback();
      });
    }

    function loadProfilesRange (dateFrom, dateTo, dayCount, callback) {
      $('#info > b').html('<b>' + translate('Loading profile range') + ' ...</b>');

      $.when(
          loadProfilesRangeCore(dateFrom, dateTo, dayCount)
          , loadProfilesRangePrevious(dateFrom)
          , loadProfilesRangeNext(dateTo)
        )
        .done(callback)
        .fail(function() {
          datastorage.profiles = [];
        });
    }

    function loadProfilesRangeCore (dateFrom, dateTo) {
      $('#info > b').html('<b>' + translate('Loading core profiles') + ' ...</b>');

      //The results must be returned in descending order to work with key logic in routines such as getCurrentProfile
      const tquery = '?find[startDate][$gte]=' + new Date(dateFrom).toISOString() + '&find[startDate][$lte]=' + new Date(dateTo).toISOString() + '&sort[startDate]=-1&count=1000';

      return $.ajax('/api/v1/profiles' + tquery, {
        headers: client.headers()
        , async: false
        , success: function(records) {
          datastorage.profiles = records;
        }
      });
    }

    function loadProfilesRangePrevious (dateFrom) {
      $('#info > b').html('<b>' + translate('Loading previous profile') + ' ...</b>');

      //Find first one before the start date and add to datastorage.profiles
      const tquery = '?find[startDate][$lt]=' + new Date(dateFrom).toISOString() + '&sort[startDate]=-1&count=1';

      return $.ajax('/api/v1/profiles' + tquery, {
        headers: client.headers()
        , async: false
        , success: function(records) {
          records.forEach(function(r) {
            datastorage.profiles.push(r);
          });
        }
      });
    }

    function loadProfilesRangeNext (dateTo) {
      $('#info > b').html('<b>' + translate('Loading next profile') + ' ...</b>');

      //Find first one after the end date and add to datastorage.profiles
      const tquery = '?find[startDate][$gt]=' + new Date(dateTo).toISOString() + '&sort[startDate]=1&count=1';

      return $.ajax('/api/v1/profiles' + tquery, {
        headers: client.headers()
        , async: false
        , success: function(records) {
          records.forEach(function(r) {
            //must be inserted as top to maintain profiles being sorted by date in descending order
            datastorage.profiles.unshift(r);
          });
        }
      });
    }

    function processData (data, day, options, callback) {
      if (daystoshow[day].treatmentsonly) {
        datastorage[day] = data;
        callback(day);
        return;
      }
      // treatments
      data.dailyCarbs = 0;
      data.dailyProtein = 0;
      data.dailyFat = 0;

      data.treatments.forEach(function(d) {
        if (parseFloat(d.insulin) > maxInsulinValue) {
          maxInsulinValue = parseFloat(d.insulin);
        }
        if (parseFloat(d.carbs) > maxCarbsValue) {
          maxCarbsValue = parseFloat(d.carbs);
        }
        if (d.carbs) {
          data.dailyCarbs += Number(d.carbs);
        }
        if (d.protein) {
          data.dailyProtein += Number(d.protein);
        }
        if (d.fat) {
          data.dailyFat += Number(d.fat);
        }
      });
      if (data.dailyCarbs > maxDailyCarbsValue) {
        maxDailyCarbsValue = data.dailyCarbs;
      }

      const cal = data.cal[data.cal.length - 1];
      let temp1 = [];
      const rawbg = client.rawbg;
      if (cal) {
        temp1 = data.sgv.map(function(entry) {
          entry.mgdl = entry.y; // value names changed from enchilada
          const rawBg = rawbg.calc(entry, cal);
          return {
            mills: entry.mills
            , date: new Date(entry.mills - 2 * 1000)
            , y: rawBg
            , sgv: client.utils.scaleMgdl(rawBg)
            , color: 'gray'
            , type: 'rawbg'
            , filtered: entry.filtered
            , unfiltered: entry.unfiltered
          };
        }).filter(function(entry) {
          return entry.y > 0
        });
      }
      const temp2 = data.sgv.map(function(obj) {
        return {
          mills: obj.mills
          , date: new Date(obj.mills)
          , y: obj.y
          , sgv: client.utils.scaleMgdl(obj.y)
          , color: sgvToColor(client.utils.scaleMgdl(obj.y), options)
          , type: 'sgv'
          , noise: obj.noise
          , filtered: obj.filtered
          , unfiltered: obj.unfiltered
        };
      });
      data.sgv = [].concat(temp1, temp2);

      //Add MBG's also, pretend they are SGV's
      data.sgv = data.sgv.concat(data.mbg.map(function(obj) {
        return {
          date: new Date(obj.mills)
          , y: obj.y
          , sgv: client.utils.scaleMgdl(obj.y)
          , color: 'red'
          , type: 'mbg'
          , device: obj.device
        }
      }));

      // make sure data range will be exactly 24h
      const from = client.sbx.data.profile.parseInTimezone(day).toDate();
      const to = new Date(from.getTime() + 1000 * 60 * 60 * 24);
      data.sgv.push({ date: from, y: 40, sgv: 40, color: 'transparent', type: 'rawbg' });
      data.sgv.push({ date: to, y: 40, sgv: 40, color: 'transparent', type: 'rawbg' });

      // clear error data. we don't need it to display them
      data.sgv = data.sgv.filter(function(d) {
        return d.y >= 39;
      });
      data.sgv = data.sgv.map(function eachSgv (sgv) {
        const status = data.devicestatus.find(function(d) {
          return d.mills >= sgv.mills && d.mills < sgv.mills + 5 * 60 * 1000;
        });

        if (status && status.openaps) {
          sgv.openaps = status.openaps;
        }
        return sgv;
      });

      // for other reports
      data.statsrecords = data.sgv.filter(function(r) {
        if (r.type) {
          return r.type === 'sgv';
        } else {
          return true;
        }
      }).map(function(r) {
        const ret = {};
        ret.sgv = parseFloat(r.sgv);
        ret.bgValue = parseInt(r.y);
        ret.displayTime = r.date;
        return ret;
      });

      datastorage[day] = data;
      callback(day);
    }

    function maybePrevent (event) {
      if (event) {
        event.preventDefault();
      }
      return false;
    }
  });
};

module.exports = init;
