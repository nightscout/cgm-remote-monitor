'use strict';

var _ = require('lodash');
var $ = (global && global.$) || require('jquery');
var d3 = (global && global.d3) || require('d3');

var language = require('../language')();
var sandbox = require('../sandbox')();
var profile = require('../profilefunctions')();
var units = require('../units')();
var levels = require('../levels');
var times = require('../times');

var client = { };

client.init = function init(serverSettings, plugins) {

  var UPDATE_TRANS_MS = 750 // milliseconds
    , FORMAT_TIME_12 = '%-I:%M %p'
    , FORMAT_TIME_12_COMPACT = '%-I:%M'
    , FORMAT_TIME_24 = '%H:%M%'
    , FORMAT_TIME_12_SCALE = '%-I %p'
    , FORMAT_TIME_24_SCALE = '%H'
    ;

  var chart
    , socket
    , isInitialData = false
    , SGVdata = []
    , MBGdata = []
    , latestUpdateTime
    , prevSGV
    , devicestatusData
    , opacity = {current: 1, DAY: 1, NIGHT: 0.5}
    , clientAlarms = {}
    , alarmInProgress = false
    , alarmMessage
    , currentAlarmType = null
    , currentAnnouncement
    , alarmSound = 'alarm.mp3'
    , urgentAlarmSound = 'alarm2.mp3'
    ;

  client.entryToDate = function entryToDate (entry) { return new Date(entry.mills) };

  client.now = Date.now();
  client.forecastTime = times.mins(30).msecs;
  client.data = [];
  client.browserUtils = require('./browser-utils')($);
  client.settings = require('./browser-settings')(client, plugins, serverSettings, $);
  client.utils = require('../utils')(client.settings);

  client.sbx = sandbox.clientInit(client.settings, client.now);
  client.rawbg = plugins('rawbg');
  client.delta = plugins('delta');
  client.direction = plugins('direction');
  client.errorcodes = plugins('errorcodes');

  language.set(client.settings.language).DOMtranslate($);
  client.translate = language.translate;
  
  client.hashauth = require('../hashauth');
  client.hashauth.init(client, $).initAuthentication();

  client.tooltip = d3.select('body').append('div')
    .attr('class', 'tooltip')
    .style('opacity', 0);

  client.foucusRangeMS = times.hours(3).msecs;
  client.brushed = brushed;
  client.formatTime = formatTime;
  client.dataUpdate = dataUpdate;

  client.renderer = require('./renderer')(client, d3, $);
  client.careportal = require('./careportal')(client, $);

  var timeAgo = client.utils.timeAgo;

  var container = $('.container')
    , bgStatus = $('.bgStatus')
    , currentBG = $('.bgStatus .currentBG')
    , majorPills = $('.bgStatus .majorPills')
    , minorPills = $('.bgStatus .minorPills')
    , statusPills = $('.status .statusPills')
    ;

  client.dataExtent = function dataExtent ( ) {
    return client.data.length > 0 ?
      d3.extent(client.data, client.entryToDate)
      : d3.extent([new Date(client.now - times.hours(48).msecs), new Date(client.now)]);
  };

  client.bottomOfPills = function bottomOfPills ( ) {
    //the offset's might not exist for some tests
    var bottomOfMinorPills = minorPills.offset() ? minorPills.offset().top + minorPills.height() : 0;
    var bottomOfStatusPills = statusPills.offset() ? statusPills.offset().top + statusPills.height() : 0;
    return Math.max(bottomOfMinorPills, bottomOfStatusPills);
  };

  function formatTime(time, compact) {
    var timeFormat = getTimeFormat(false, compact);
    time = d3.time.format(timeFormat)(time);
    if (client.settings.timeFormat !== 24) {
      time = time.toLowerCase();
    }
    return time;
  }

  function getTimeFormat(isForScale, compact) {
    var timeFormat = FORMAT_TIME_12;
    if (client.settings.timeFormat === 24) {
      timeFormat = isForScale ? FORMAT_TIME_24_SCALE : FORMAT_TIME_24;
    } else {
      timeFormat = isForScale ? FORMAT_TIME_12_SCALE : (compact ? FORMAT_TIME_12_COMPACT : FORMAT_TIME_12);
    }

    return timeFormat;
  }

  //TODO: replace with utils.scaleMgdl and/or utils.roundBGForDisplay
  function scaleBg(bg) {
    if (client.settings.units === 'mmol') {
      return units.mgdlToMMOL(bg);
    } else {
      return bg;
    }
  }

  function generateTitle ( ) {
    function s(value, sep) { return value ? value + ' ' : sep || ''; }

    var title = '';

    var time = client.latestSGV ? client.latestSGV.mills : (prevSGV ? prevSGV.mills : -1)
      , ago = timeAgo(time);

    if (ago && ago.status !== 'current') {
      title =  s(ago.value) + s(ago.label, ' - ') + title;
    } else if (client.latestSGV) {
      var currentMgdl = client.latestSGV.mgdl;

      if (currentMgdl < 39) {
        title = s(client.errorcodes.toDisplay(currentMgdl), ' - ') + title;
      } else {
        var deltaDisplay = client.delta.calc(prevSGV, client.latestSGV, client.sbx).display;
        title = s(scaleBg(currentMgdl)) + s(deltaDisplay) + s(client.direction.info(client.latestSGV).label) + title;
      }
    }
    return title;
  }

  function resetCustomTitle ( ) {
    var customTitle = client.settings.customTitle || 'Nightscout';
    $('.customTitle').text(customTitle);
  }

  function checkAnnouncement() {
    var result = {
      inProgress: currentAnnouncement ? Date.now() - currentAnnouncement.received < times.mins(5).msecs : false
    };

    if (result.inProgress) {
      var message = currentAnnouncement.message.length > 1 ? currentAnnouncement.message : currentAnnouncement.title;
      result.message = message;
      $('.customTitle').text(message);
    } else if (currentAnnouncement) {
      currentAnnouncement = null;
      console.info('cleared announcement');
    }

    return result;
  }

  function updateTitle ( ) {

    var windowTitle;
    var announcementStatus = checkAnnouncement();

    if (alarmMessage && alarmInProgress) {
      $('.customTitle').text(alarmMessage);
      if (!isTimeAgoAlarmType(currentAlarmType)) {
        windowTitle = alarmMessage + ': ' + generateTitle();
      }
    } else if (announcementStatus.inProgress && announcementStatus.message) {
      windowTitle = announcementStatus.message + ': ' + generateTitle();
    } else  {
      resetCustomTitle();
    }

    container.toggleClass('announcing', announcementStatus.inProgress);

    $(document).attr('title', windowTitle || generateTitle());
  }

// clears the current user brush and resets to the current real time data
  function updateBrushToNow(skipBrushing) {

    // get current time range
    var dataRange = client.dataExtent();

    // update brush and focus chart with recent data
    d3.select('.brush')
      .transition()
      .duration(UPDATE_TRANS_MS)
      .call(chart.brush.extent([new Date(dataRange[1].getTime() - client.foucusRangeMS), dataRange[1]]));

    if (!skipBrushing) {
      brushed();
    }
  }

  function alarmingNow() {
    return container.hasClass('alarming');
  }

  function inRetroMode() {
    return chart && chart.inRetroMode();
  }

  function brushed ( ) {

    var brushExtent = chart.brush.extent();

    // ensure that brush extent is fixed at 3.5 hours
    if (brushExtent[1].getTime() - brushExtent[0].getTime() !== client.foucusRangeMS) {
      // ensure that brush updating is with the time range
      if (brushExtent[0].getTime() + client.foucusRangeMS > client.dataExtent()[1].getTime()) {
        brushExtent[0] = new Date(brushExtent[1].getTime() - client.foucusRangeMS);
        d3.select('.brush')
          .call(chart.brush.extent([brushExtent[0], brushExtent[1]]));
      } else {
        brushExtent[1] = new Date(brushExtent[0].getTime() + client.foucusRangeMS);
        d3.select('.brush')
          .call(chart.brush.extent([brushExtent[0], brushExtent[1]]));
      }
    }

    function adjustCurrentSGVClasses(value, isCurrent) {
      var reallyCurrentAndNotAlarming = isCurrent && !inRetroMode() && !alarmingNow();

      bgStatus.toggleClass('current', alarmingNow() || reallyCurrentAndNotAlarming);
      if (!alarmingNow()) {
        container.removeClass('urgent warning inrange');
        if (reallyCurrentAndNotAlarming) {
          container.addClass(sgvToColoredRange(value));
        }
      }
      currentBG.toggleClass('icon-hourglass', value === 9);
      currentBG.toggleClass('error-code', value < 39);
      currentBG.toggleClass('bg-limit', value === 39 || value > 400);
      container.removeClass('loading');
    }

    function updateCurrentSGV (entry) {
      var value = entry.mgdl
        , ago = timeAgo(entry.mills)
        , isCurrent = ago.status === 'current';

      if (value === 9) {
        currentBG.text('');
      } else if (value < 39) {
        currentBG.html(client.errorcodes.toDisplay(value));
      } else if (value < 40) {
        currentBG.text('LOW');
      } else if (value > 400) {
        currentBG.text('HIGH');
      } else {
        currentBG.text(scaleBg(value));
      }

      adjustCurrentSGVClasses(value, isCurrent);
    }

    function updatePlugins (sgvs, time) {
      var pluginBase = plugins.base(majorPills, minorPills, statusPills, bgStatus, client.tooltip);

      client.sbx = sandbox.clientInit(
        client.settings
        , new Date(time).getTime() //make sure we send a timestamp
        , pluginBase, {
        sgvs: sgvs
        , cals: [client.cal]
        , treatments: client.treatments
        , profile: profile
        , uploaderBattery: devicestatusData && devicestatusData.uploaderBattery
        , inRetroMode: inRetroMode()
      });

      //all enabled plugins get a chance to set properties, even if they aren't shown
      plugins.setProperties(client.sbx);

      //only shown plugins get a chance to update visualisations
      plugins.updateVisualisations(client.sbx);
    }

    function clearCurrentSGV ( ) {
      currentBG.text('---');
      container.removeClass('urgent warning inrange');
    }

    var nowDate = null;
    var nowData = client.data.filter(function(d) {
      return d.type === 'sgv' && d.mills <= brushExtent[1].getTime();
    });
    var focusPoint = _.last(nowData);

    function updateHeader() {
      if (inRetroMode()) {
        nowDate = brushExtent[1];
        $('#currentTime')
          .text(formatTime(nowDate, true))
          .css('text-decoration', 'line-through');
      } else {
        nowDate = new Date(client.now);
        updateClockDisplay();
      }

      if (focusPoint) {
        if (brushExtent[1].getTime() - focusPoint.mills > times.mins(15).msecs) {
          clearCurrentSGV();
        } else {
          updateCurrentSGV(focusPoint);
        }
        updatePlugins(nowData, nowDate.getTime());
      } else {
        clearCurrentSGV();
        updatePlugins([], nowDate);
      }
    }

    updateHeader();
    updateTimeAgo();
    if (chart.prevChartHeight) {
      chart.scroll(nowDate);
    }

    $('#chartContainer').css('top', (client.bottomOfPills() + 5) + 'px');
  }

  function sgvToColor(sgv) {
    var color = 'grey';

    if (client.settings.theme === 'colors') {
      if (sgv > client.settings.thresholds.bgHigh) {
        color = 'red';
      } else if (sgv > client.settings.thresholds.bgTargetTop) {
        color = 'yellow';
      } else if (sgv >= client.settings.thresholds.bgTargetBottom && sgv <= client.settings.thresholds.bgTargetTop) {
        color = '#4cff00';
      } else if (sgv < client.settings.thresholds.bgLow) {
        color = 'red';
      } else if (sgv < client.settings.thresholds.bgTargetBottom) {
        color = 'yellow';
      }
    }

    return color;
  }

  function sgvToColoredRange(sgv) {
    var range = '';

    if (client.settings.theme === 'colors') {
      if (sgv > client.settings.thresholds.bgHigh) {
        range = 'urgent';
      } else if (sgv > client.settings.thresholds.bgTargetTop) {
        range = 'warning';
      } else if (sgv >= client.settings.thresholds.bgTargetBottom && sgv <= client.settings.thresholds.bgTargetTop) {
        range = 'inrange';
      } else if (sgv < client.settings.thresholds.bgLow) {
        range = 'urgent';
      } else if (sgv < client.settings.thresholds.bgTargetBottom) {
        range = 'warning';
      }
    }

    return range;
  }

  function setAlarmMessage (notify) {
    var announcementMessage = notify && notify.isAnnouncement && notify.message && notify.message.length > 1;

    if (announcementMessage) {
      alarmMessage = levels.toDisplay(notify.level) + ': ' + notify.message;
    } else if (notify) {
      alarmMessage = notify.title;
    } else {
      alarmMessage = null;
    }
  }

  function generateAlarm (file, notify) {
    alarmInProgress = true;

    setAlarmMessage(notify);
    var selector = '.audio.alarms audio.' + file;

    if (!alarmingNow()) {
      d3.select(selector).each(function () {
        var audio = this;
        playAlarm(audio);
        $(this).addClass('playing');
      });
    }

    container.addClass('alarming').addClass(file === urgentAlarmSound ? 'urgent' : 'warning');

    updateTitle();
  }

  function playAlarm(audio) {
    // ?mute=true disables alarms to testers.
    if (client.browserUtils.queryParms().mute !== 'true') {
      audio.play();
    } else {
      client.browserUtils.showNotification('Alarm was muted (?mute=true)');
    }
  }

  function stopAlarm(isClient, silenceTime) {
    alarmInProgress = false;
    alarmMessage = null;
    container.removeClass('urgent warning');
    d3.selectAll('audio.playing').each(function () {
      var audio = this;
      audio.pause();
      $(this).removeClass('playing');
    });

    client.browserUtils.closeNotification();
    container.removeClass('alarming');

    updateTitle();

    // only emit ack if client invoke by button press
    if (isClient) {
      if (isTimeAgoAlarmType(currentAlarmType)) {
        container.removeClass('alarming-timeago');
        var alarm = getClientAlarm(currentAlarmType);
        alarm.lastAckTime = Date.now();
        alarm.silenceTime = silenceTime;
      }
      socket.emit('ack', currentAlarmType || 'alarm', silenceTime);
    }

    brushed();
  }

  function updateClock() {
    updateClockDisplay();
    var interval = (60 - (new Date()).getSeconds()) * 1000 + 5;
    setTimeout(updateClock,interval);

    updateTimeAgo();

    // Dim the screen by reducing the opacity when at nighttime
    if (client.settings.nightMode) {
      var dateTime = new Date();
      if (opacity.current !== opacity.NIGHT && (dateTime.getHours() > 21 || dateTime.getHours() < 7)) {
        $('body').css({ 'opacity': opacity.NIGHT });
      } else {
        $('body').css({ 'opacity': opacity.DAY });
      }
    }
  }

  function updateClockDisplay() {
    if (inRetroMode()) {
      return;
    }
    client.now = Date.now();
    $('#currentTime').text(formatTime(new Date(client.now), true)).css('text-decoration', '');
  }

  function getClientAlarm(type) {
    var alarm = clientAlarms[type];
    if (!alarm) {
      alarm = { type: type };
      clientAlarms[type] = alarm;
    }
    return alarm;
  }

  function isTimeAgoAlarmType(alarmType) {
    return alarmType === 'warnTimeAgo' || alarmType === 'urgentTimeAgo';
  }

  function isStale (ago) {
    return client.settings.alarmTimeagoWarn && ago.status === 'warn'
      || client.settings.alarmTimeagoUrgent && ago.status === 'urgent';
  }

  function notAcked (alarm) {
    return Date.now() >= (alarm.lastAckTime || 0) + (alarm.silenceTime || 0);
  }

  function checkTimeAgoAlarm(ago) {
    var level = ago.status
      , alarm = getClientAlarm(level + 'TimeAgo');

    if (isStale(ago) && notAcked(alarm)) {
      currentAlarmType = alarm.type;
      console.info('generating timeAgoAlarm', alarm.type);
      container.addClass('alarming-timeago');
      var message = {'title': 'Last data received ' + [ago.value, ago.label].join(' ')};
      var sound = level === 'warn' ? alarmSound : urgentAlarmSound;
      generateAlarm(sound, message);
    }

    container.toggleClass('alarming-timeago', ago.status !== 'current');

    if (alarmingNow() && ago.status === 'current' && isTimeAgoAlarmType(currentAlarmType)) {
      stopAlarm(true, times.min().msecs);
    }
  }

  function updateTimeAgo() {
    var lastEntry = $('#lastEntry')
      , time = client.latestSGV ? client.latestSGV.mills : -1
      , ago = timeAgo(time)
      , retroMode = inRetroMode();

    function updateTimeAgoPill() {
      if (retroMode || !ago.value) {
        lastEntry.find('em').hide();
      } else {
        lastEntry.find('em').show().text(ago.value);
      }
      if (retroMode || ago.label) {
        lastEntry.find('label').show().text(retroMode ? 'RETRO' : ago.label);
      } else {
        lastEntry.find('label').hide();
      }
    }

    lastEntry.removeClass('current warn urgent');
    lastEntry.addClass(ago.status);

    if (ago.status !== 'current') {
      updateTitle();
    }
    checkTimeAgoAlarm(ago);

    updateTimeAgoPill();
  }

  function updateTimeAgoSoon() {
    setTimeout(function updatingTimeAgoNow() {
      updateTimeAgo();
    }, times.secs(10).msecs);
  }

  function refreshChart(updateToNow) {
    if (updateToNow) {
      updateBrushToNow();
    }
    chart.update(false);
  }

  (function watchVisibility ( ) {
    // Set the name of the hidden property and the change event for visibility
    var hidden, visibilityChange;
    if (typeof document.hidden !== 'undefined') {
      hidden = 'hidden';
      visibilityChange = 'visibilitychange';
    } else if (typeof document.mozHidden !== 'undefined') {
      hidden = 'mozHidden';
      visibilityChange = 'mozvisibilitychange';
    } else if (typeof document.msHidden !== 'undefined') {
      hidden = 'msHidden';
      visibilityChange = 'msvisibilitychange';
    } else if (typeof document.webkitHidden !== 'undefined') {
      hidden = 'webkitHidden';
      visibilityChange = 'webkitvisibilitychange';
    }

    document.addEventListener(visibilityChange, function visibilityChanged ( ) {
      var prevHidden = client.documentHidden;
      client.documentHidden = document[hidden];

      if (prevHidden && !client.documentHidden) {
        console.info('Document now visible, updating - ' + new Date());
        refreshChart(true);
      }
    });
  })();

  window.onresize = refreshChart;

  updateClock();
  updateTimeAgoSoon();

  function Dropdown(el) {
    this.ddmenuitem = 0;

    this.$el = $(el);
    var that = this;

    $(document).click(function() { that.close(); });
  }
  Dropdown.prototype.close = function () {
    if (this.ddmenuitem) {
      this.ddmenuitem.css('visibility', 'hidden');
      this.ddmenuitem = 0;
    }
  };
  Dropdown.prototype.open = function (e) {
    this.close();
    this.ddmenuitem = $(this.$el).css('visibility', 'visible');
    e.stopPropagation();
  };

  var silenceDropdown = new Dropdown('.dropdown-menu');

  $('.bgButton').click(function (e) {
    if (alarmingNow()) {
      silenceDropdown.open(e);
    }
  });

  $('#silenceBtn').find('a').click(function (e) {
    stopAlarm(true, $(this).data('snooze-time'));
    e.preventDefault();
  });

  $('.focus-range li').click(function(e) {
    var li = $(e.target);
    $('.focus-range li').removeClass('selected');
    li.addClass('selected');
    var hours = Number(li.data('hours'));
    client.foucusRangeMS = times.hours(hours).msecs;
    refreshChart();
  });

  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  // Client-side code to connect to server and handle incoming data
  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  socket = io.connect();

  function mergeDataUpdate(isDelta, cachedDataArray, receivedDataArray) {

    function nsArrayDiff(oldArray, newArray) {
      var seen = {};
      var l = oldArray.length;
      for (var i = 0; i < l; i++) { seen[oldArray[i].mills] = true }
      var result = [];
      l = newArray.length;
      for (var j = 0; j < l; j++) { if (!seen.hasOwnProperty(newArray[j].mills)) { result.push(newArray[j]); console.log('delta data found'); } }
      return result;
    }

    // If there was no delta data, just return the original data
    if (!receivedDataArray) {
      return cachedDataArray || [];
    }

    // If this is not a delta update, replace all data
    if (!isDelta) {
      return receivedDataArray || [];
    }

    // If this is delta, calculate the difference, merge and sort
    var diff = nsArrayDiff(cachedDataArray, receivedDataArray);
    return cachedDataArray.concat(diff).sort(function(a, b) {
      return a.mills - b.mills;
    });
  }

  socket.on('dataUpdate', dataUpdate);

  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  // Alarms and Text handling
  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  socket.on('connect', function () {
    console.log('Client connected to server.');
  });


  //with predicted alarms, latestSGV may still be in target so to see if the alarm
  //  is for a HIGH we can only check if it's >= the bottom of the target
  function isAlarmForHigh() {
    return client.latestSGV.mgdl >= client.settings.thresholds.bgTargetBottom;
  }

  //with predicted alarms, latestSGV may still be in target so to see if the alarm
  //  is for a LOW we can only check if it's <= the top of the target
  function isAlarmForLow() {
    return client.latestSGV.mgdl <= client.settings.thresholds.bgTargetTop;
  }

  socket.on('announcement', function (notify) {
    console.info('announcement received from server');
    console.log('notify:',notify);
    currentAnnouncement = notify;
    currentAnnouncement.received = Date.now();
    updateTitle();
  });

  socket.on('alarm', function (notify) {
    console.info('alarm received from server');
    console.log('notify:',notify);
    var enabled = (isAlarmForHigh() && client.settings.alarmHigh) || (isAlarmForLow() && client.settings.alarmLow);
    if (enabled) {
      console.log('Alarm raised!');
      currentAlarmType = 'alarm';
      generateAlarm(alarmSound,notify);
    } else {
      console.info('alarm was disabled locally', client.latestSGV.mgdl, client.settings);
    }
    chart.update(false);
  });

  socket.on('urgent_alarm', function (notify) {
    console.info('urgent alarm received from server');
    console.log('notify:',notify);

    var enabled = (isAlarmForHigh() && client.settings.alarmUrgentHigh) || (isAlarmForLow() && client.settings.alarmUrgentLow);
    if (enabled) {
      console.log('Urgent alarm raised!');
      currentAlarmType = 'urgent_alarm';
      generateAlarm(urgentAlarmSound,notify);
    } else {
      console.info('urgent alarm was disabled locally', client.latestSGV.mgdl, client.settings);
    }
    chart.update(false);
  });

  socket.on('clear_alarm', function () {
    if (alarmInProgress) {
      console.log('clearing alarm');
      stopAlarm();
    }
  });

  $('#testAlarms').click(function(event) {
    d3.selectAll('.audio.alarms audio').each(function () {
      var audio = this;
      playAlarm(audio);
      setTimeout(function() {
        audio.pause();
      }, 4000);
    });
    event.preventDefault();
  });

  $('.appName').text(serverSettings.name);
  $('.version').text(serverSettings.version);
  $('.head').text(serverSettings.head);
  if (serverSettings.apiEnabled) {
    $('.serverSettings').show();
  }
  $('#treatmentDrawerToggle').toggle(serverSettings.careportalEnabled);
  container.toggleClass('has-minor-pills', plugins.hasShownType('pill-minor', client.settings));


  function prepareData ( ) {
  // Post processing after data is in
    var temp1 = [ ];
    if (client.cal && client.rawbg.isEnabled(client.sbx)) {
      temp1 = SGVdata.map(function (entry) {
        var rawbgValue = client.rawbg.showRawBGs(entry.mgdl, entry.noise, client.cal, client.sbx) ? client.rawbg.calc(entry, client.cal, client.sbx) : 0;
        if (rawbgValue > 0) {
          return { mills: entry.mills - 2000, mgdl: rawbgValue, color: 'white', type: 'rawbg' };
        } else {
          return null;
        }
      }).filter(function (entry) {
        return entry !== null;
      });
    }
    var temp2 = SGVdata.map(function (obj) {
      return { mills: obj.mills, mgdl: obj.mgdl, direction: obj.direction, color: sgvToColor(obj.mgdl), type: 'sgv', noise: obj.noise, filtered: obj.filtered, unfiltered: obj.unfiltered};
    });
    client.data = [];
    client.data = client.data.concat(temp1, temp2);

    client.data = client.data.concat(MBGdata.map(function (obj) {
      return { mills: obj.mills, mgdl: obj.mgdl, color: 'red', type: 'mbg', device: obj.device };
    }));

    client.data.forEach(function (point) {
      if (point.mgdl < 39) {
        point.color = 'transparent';
      }
    });
  }

  function dataUpdate (d) {

    if (!d) {
      return;
    }

    // Calculate the diff to existing data and replace as needed
    SGVdata = mergeDataUpdate(d.delta, SGVdata, d.sgvs);
    MBGdata = mergeDataUpdate(d.delta,MBGdata, d.mbgs);
    client.treatments = mergeDataUpdate(d.delta, client.treatments, d.treatments);

    // Do some reporting on the console
    console.log('Total SGV data size', SGVdata.length);
    console.log('Total treatment data size', client.treatments.length);

    if (d.profiles) {
      profile.loadData(d.profiles);
    }

    if (d.cals) { client.cal = d.cals[d.cals.length-1]; }
    if (d.devicestatus) { devicestatusData = d.devicestatus; }

    if (d.sgvs) {
      // change the next line so that it uses the prediction if the signal gets lost (max 1/2 hr)
      latestUpdateTime = Date.now();
      client.latestSGV = SGVdata[SGVdata.length - 1];
      prevSGV = SGVdata[SGVdata.length - 2];
    }

    prepareData();
    updateTitle();

    if (!isInitialData) {
      isInitialData = true;
      chart = client.chart = require('./chart')(client, d3, $);
      brushed();
      chart.update(true);
    } else {
      chart.update(false);
    }

  }
};

module.exports = client;