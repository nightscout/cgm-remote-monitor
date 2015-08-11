'use strict';



(function () {
  var c_profile = null;
  
  //var moment = require('moment-timezone');
  
  if (serverSettings === undefined) {
    console.error('server settings were not loaded, will not call init');
  } else {
    window.Nightscout.client.init(serverSettings, Nightscout.plugins);
  }
  
  var translate = Nightscout.client.translate;

  var defaultprofile = {
      //General values
      "dia":3,
      
      // Simple style values, "from" are in minutes from midnight
      "carbratio": [
        {
          "time": "00:00",
          "value": 30
        }],
      "carbs_hr":30,
      "delay": 20,
      "sens": [
        {
          "time": "00:00",
          "value": 17
        }],
      "startDate": new Date(),
      "timezone": "UTC",
      
      //perGIvalues style values
      "perGIvalues": false,
      "carbs_hr_high": 30,
      "carbs_hr_medium": 30,
      "carbs_hr_low": 30,
      "delay_high": 15,
      "delay_medium": 20,
      "delay_low": 20,

      "basal":[
        {
          "time": "00:00",
          "value": 0.1
        }],
      "target_low":[
        {
          "time": "00:00",
          "value": 0
        }],
      "target_high":[
        {
          "time": "00:00",
          "value": 0
        }]
  };
  defaultprofile.startDate.setSeconds(0);
  defaultprofile.startDate.setMilliseconds(0);

  var icon_add = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABa0lEQVQ4T6WTzysEYRjHP+/Mrv2hHOTuqJRNOfgPSORHokg4OClHcnVzVygHF6WIcuHMnyCHVRyI3ZYxa23vzOzs7LzamaI0e5i89fTWt/f5vPV5n1cQsXLbHepvfLv5JaLORoZNwMbyFo5vYfsWB0c7xAasLa5T/vCg45Oj48P4gJWFVYxCA63L5PzkND5gfm4Jo+Chd5W5OrtsDYgS1pQ1OTuNUfTQO8tcX9xE+QugYnS/X81MzGP7MpTWkEFVZY1KxcVPV3h27zAtA+oCagIcDfWUCgEje31qfHwK06gHjaF5iXQcHCV5lHmqqgQCNEAI0IsavCVDwNBurxoeGwmaAkDDwvYsqtIh//6AJUoklP97s62BbJYeAqIcpJNZsoM+r2aVbKKOekiBL8An3BuAEiGg1SSKAYnttpFxPdR9Jv4zipxFTUuQKqsfYbFGWfTYuO06yRfxIyweoLuG+iMsFuBfvzFy7FqE33vs2BFqlfN5AAAAAElFTkSuQmCC";
  var icon_remove = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACrElEQVQ4T42Ty2sTQRzHv5tmk2yyjRNtpfZhL8V6s2KoUNC2XqwgaCsVQcGiFqpHi0c9iRdR/ANE9KR40FIQX4cueKoPaKFoLdSYNtE0abKT1+5s9iW7aUMiHtzTzO7v85md+c6PA4DrHbsPCKIgOWO1pA7dT6YXnXH949SE/F63pqwZtRrO+SCKgjQ5NUV+azpmHj2krMwaJC4c8Erj+/eRyloMMwWFKgbn1nC3ervlK1evkXBLGBZT8SOewotnTylTNLdgeg/pDgZDC2cPHSR8bB22DVC9hFe0SG/H0xFXcHlykjRHRDBWgJcZSCY38Xx2lhqMnRYE34Px/sN9vlQWeoHBAx2yXsRruVAVuFsIBaSJ8+eJGPaBqQV4NROJjTzez89jLBoFn6FgybQL54wS3uTyVDFQ3cL2IYpBv3RhdJSIIQ80tQyv7gEqJvS8AmUlBs7UXPhtjtZgh3UFNYngk86NHCfNAg9dMwHVBPu+CpsVkTXKeJeVG+AGgTOZ3tt6MSKKjy+NjEBjFrR4ElZmA4pdxstMFsyyJu6tZZ7Ux9vwB6EAL50ZGiRECEPPUOixVTRxHlicgSVWxEdZpuZWfNuS2hk48NjwMIkIYZglBnV5Cbqtws/5IaAJmsfCglrEl2y2QeKmEBJ80tixKmxrFpSVr0gV0viQoxho2YUuPohmeFD22PiklLC4ma5JuBvdrfLJI0dJd0s7bM0ES8aR/BXDXGaTskqlL+D3Lwy0tZEePoAd4EA5YF4tYymdonfjmQh3s6dTPjU4SHYGwjAKecSXFyGlM1TdytntE56T+ts7SC/vhw3gm6njc2Kd3vm5Ub1IwQAvnYhGiZpYw1wiWYPrIw7wnBTt7CLOOwdmut14kQQvqt24tfK/utGR6LaF+iRqMf4N/O/8D28HiiCRYqzAAAAAAElFTkSuQmCC";
  
  var mongoprofiles = [];

  // Fetch data from mongo
  $('#pe_status').hide().text('Loading profile records ...').fadeIn("slow");
  $.ajax('/api/v1/profile.json', {
    success: function (records) {
      c_profile = {};
      mongoprofiles = records;
      // create new profile to be edited from last record
      if (records[0] && records[0].dia) {
        // Use only values(keys) defined in defaultprofile, drop the rest. Preparation for future changes.
        c_profile = _.cloneDeep(defaultprofile);
        for (var key in records[0]) {
          if (records[0].hasOwnProperty(key)) {
            if (typeof c_profile[key] !== 'undefined') {
              c_profile[key] = records[0][key];
            }
            // copy _id of record too
            if (key === '_id') {
              c_profile[key] = records[0][key];
            }
          }
        }
        convertToRanges(c_profile);
        
        $('#pe_status').hide().text('Values loaded.').fadeIn("slow");
        mongoprofiles.unshift(c_profile);
      } else {
        c_profile = _.cloneDeep(defaultprofile);
        mongoprofiles.unshift(c_profile);
        $('#pe_status').hide().text('Default values used.').fadeIn("slow");
      }
    },
    error: function () {
      c_profile = _.cloneDeep(defaultprofile);
      mongoprofiles.unshift(c_profile);
      $('#pe_status').hide().text('Error. Default values used.').fadeIn("slow");
    }
  }).done(initeditor);
  
  // convert simple values to ranges if needed
  function convertToRanges(profile) {
    if (typeof profile.carbratio !== 'object') { profile.carbratio = [{ 'time': '00:00', 'value': profile.carbratio }]; }
    if (typeof profile.sens !== 'object') { profile.sens = [{ 'time': '00:00', 'value': profile.sens }]; }
    if (typeof profile.target_low !== 'object') { profile.target_low = [{ 'time': '00:00', 'value': profile.target_low }]; }
    if (typeof profile.target_high !== 'object') { profile.target_high = [{ 'time': '00:00', 'value': profile.target_high }]; }
    if (profile.target_high.length !== profile.target_low.length) {
      alert('Time ranges of target_low and target_high don\'t  match. Values are restored to defaults.');
      profile.target_low = _.cloneDeep(defaultprofile.target_low);
      profile.target_high = _.cloneDeep(defaultprofile.target_high);
    }
  }
  
  function initeditor() {
    // Load timezones
    $('#pe_timezone').empty();
    moment.tz.names().forEach(function addTz(tz) {
      $('#pe_timezone').append(new Option(tz,tz));
    });

    $('#pe_form').find('button').click(profileSubmit);
    
    // Add handler for style switching
    $('#pe_perGIvalues').change(switchStyle);

    // display status
    $('#pe_units').text(serverSettings.settings.units);
    $('#pe_timeformat').text(serverSettings.settings.timeFormat+'h');
    $('#pe_title').text(serverSettings.settings.customTitle);

    var lastvalidfrom = new Date(mongoprofiles[1] && mongoprofiles[1].startDate ? mongoprofiles[1].startDate : null);
    
    //timepicker
    $('#pe_date').on('change', dateChanged);
    $('#pe_time').on('change', dateChanged);

  
    // Set values from profile to html
    fillTimeRanges();
    // hide unused style of ratios
    switchStyle();
    // show proper submit button
    dateChanged();
    
    // date of last record
    if (lastvalidfrom) {
      $('#pe_lastrecvalidfrom').html('Last record date: '+lastvalidfrom.toLocaleString()+' <i>(Date must be newer to create new record or the same to update current record)</i>');
    } else  {
      $('#pe_lastrecvalidfrom').html('');
    }
    console.log('Done initeditor()');
  }
  
  // Handling valid from date change
  function dateChanged(event) {
    var newdate = new Date(Nightscout.client.utils.mergeInputTime($('#pe_time').val(), $('#pe_date').val()));
    if (mongoprofiles.length<2 || !mongoprofiles[1].startDate || mongoprofiles.length>=2 && new Date(mongoprofiles[1].startDate).getTime() === newdate.getTime()) {
      $('#pe_submit').text('Update record').css('display','');
      $('#pe_time').css({'background-color':'white'});
      $('#pe_date').css({'background-color':'white'});
      $('#pe_submit').css({'background-color':'buttonface'});
    } else if (mongoprofiles.length<2 || new Date(mongoprofiles[1].startDate).getTime() < newdate.getTime()) {
      $('#pe_submit').text('Create new record').css('display','');
      $('#pe_time').css({'background-color':'green'});
      $('#pe_date').css({'background-color':'green'});
      $('#pe_submit').css({'background-color':'green'});
    } else {
      $('#pe_submit').css('display','none');
      $('#pe_time').css({'background-color':'red'});
      $('#pe_date').css({'background-color':'red'});
      $('#pe_submit').css({'background-color':'red'});
    }
    if (event) {
      event.preventDefault();
    }
  }
  
  // Handling html events and setting/getting values
  function switchStyle(event) {
    if (!$('#pe_perGIvalues').is(':checked')) {
      $('#pe_simple').show("slow");
      $('#pe_advanced').hide("slow");
    } else {
      $('#pe_simple').hide("slow");
      $('#pe_advanced').show("slow");
    }
    if (event) {
      event.preventDefault();
    }
  }
  
  function fillTimeRanges(event) {
    var mmoltime = [
      "0:00","0:30","1:00","1:30","2:00","2:30","3:00","3:30","4:00","4:30","5:00","5:30",
      "6:00","6:30","7:00","7:30","8:00","8:30","9:00","9:30","10:00","10:30","11:00","11:30",
      "12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","17:30",
      "18:00","18:30","19:00","19:30","20:00","20:30","21:00","21:30","22:00","22:30","23:00","23:30"
    ];
    var mgtime = [
      "12:00AM","0:30AM","1:00AM","1:30AM","2:00AM","2:30AM","3:00AM","3:30AM","4:00AM","4:30AM","5:00AM","5:30AM",
      "6:00AM","6:30AM","7:00AM","7:30AM","8:00AM","8:30AM","9:00AM","9:30AM","10:00AM","10:30AM","11:00AM","11:30AM",
      "12:00PM","0:30PM","1:00PM","1:30PM","2:00PM","2:30PM","3:00PM","3:30PM","4:00PM","4:30PM","5:00PM","5:30PM",
      "6:00PM","6:30PM","7:00PM","7:30PM","8:00PM","8:30PM","9:00PM","9:30PM","10:00PM","10:30PM","11:00PM","11:30PM"
    ];
    if (event) {
      GUIToObject();
    }
    
    function shouldAddTime(i,time,array) {
      if (i===0 && time>0) { return false; }
      if (i>0 && isNaN(toMinutesFromMidnight(c_profile[array][i-1].time))) { return false; }
      if (i>0 && toMinutesFromMidnight(c_profile[array][i-1].time) >= time*30) { return false; } 
      return true;
    }
 
    function addSingleLine(e,i) {
      var tr = $('<tr>');
      var select = $('<select>').attr('class','pe_selectabletime').attr('id',e.prefix+'_from_'+i);
      var lowesttime=-1;
      for (var t=0;t<48;t++) {
        if (shouldAddTime(i,t,e.array)) { 
          if (lowesttime === -1) { lowesttime = t*30; } 
          var selected = toMinutesFromMidnight(c_profile[e.array][i].time) === t*30;
          select.append(new Option(serverSettings.settings.timeFormat==='24' ? mmoltime[t] : mgtime[t], toTimeString(t*30),selected,selected));
          }
      }
      tr.append($('<td>').append('From: ').append(select));
      tr.append($('<td>').append(e.label).append($('<input type="text">').attr('id',e.prefix+'_val_'+i).attr('value',c_profile[e.array][i].value)));
      var icons_td = $('<td>').append($('<img>').attr('class','addsingle').attr('style','cursor:pointer').attr('title','Add new interval before').attr('src',icon_add).attr('array',e.array).attr('pos',i));
      if (c_profile[e.array].lenght>1) {
        icons_td.append($('<img>').attr('class','delsingle').attr('style','cursor:pointer').attr('title','Delete interval').attr('src',icon_remove).attr('array',e.array).attr('pos',i));
      }
      tr.append(icons_td);
        
      if (lowesttime>toMinutesFromMidnight(c_profile[e.array][i].time)) { 
        c_profile[e.array][i].time = toTimeString(lowesttime);
      }
      return tr[0].outerHTML;
    }
    
    // Fill dropdown boxes
    [{prefix:'pe_basal', array:'basal', label:'Rate: '},
     {prefix:'pe_ic', array:'carbratio', label:'IC: '},
     {prefix:'pe_isf', array:'sens', label:'ISF: '}
    ].forEach(function (e) {
      var html = '<table>';
      for (var i=0; i<c_profile[e.array].length; i++) {
        html += addSingleLine(e,i);
      }
      html += '<tr><td></td><td></td><td><img class="addsingle" style="cursor:pointer" title="Add new interval before" src="'+icon_add+'" array="'+e.array+'" pos="'+i+'" href="#"></td></tr>';
      html += '</table>';
      $('#'+e.prefix+'_placeholder').html(html);
    });
    
    $('.addsingle').click(function addsingle_click() {
      var array = $(this).attr('array');
      var pos = $(this).attr('pos');
      GUIToObject(); 
      c_profile[array].splice(pos,0,{time:'00:00',value:0});
      return fillTimeRanges();
    });
    
    $('.delsingle').click(function delsingle_click() {
      var array = $(this).attr('array');
      var pos = $(this).attr('pos');
      GUIToObject(); 
      c_profile[array].splice(pos,1);
      c_profile[array][0].time = '00:00';
      return fillTimeRanges();
    });

    function addBGLine(i) {
      var tr = $('<tr>');
      var select = $('<select>').attr('class','pe_selectabletime').attr('id','pe_targetbg_from_'+i);
      var lowesttime=-1;
      for (var t=0;t<48;t++) {
        if (shouldAddTime(i,t,'target_low')) {
          if (lowesttime === -1) { lowesttime = t*30; }
          var selected = toMinutesFromMidnight(c_profile.target_low[i].time) === t*30;
          select.append(new Option(serverSettings.settings.timeFormat==='24' ? mmoltime[t] : mgtime[t], toTimeString(t*30),selected,selected));
        }
      }
      tr.append($('<td>').append('From: ').append(select));
      tr.append($('<td>').append('Low : ').append($('<input type="text">').attr('id','pe_targetbg_low_'+i).attr('value',c_profile.target_low[i].value)));
      tr.append($('<td>').append('High : ').append($('<input type="text">').attr('id','pe_targetbg_high_'+i).attr('value',c_profile.target_high[i].value)));
      var icons_td = $('<td>').append($('<img>').attr('class','addtargetbg').attr('style','cursor:pointer').attr('title','Add new interval before').attr('src',icon_add).attr('pos',i));
      if (c_profile.target_low.length>1) {
        icons_td.append($('<img>').attr('class','deltargetbg').attr('style','cursor:pointer').attr('title','Delete interval').attr('src',icon_remove).attr('pos',i));
      }
      tr.append(icons_td);
      
      // Fix time to correct value after add or change
      if (lowesttime>toMinutesFromMidnight(c_profile.target_low[i].time)) {
        c_profile.target_low[i].time = toTimeString(lowesttime);
      }
      return tr[0].outerHTML;
    }
    
    
    // target BG
    var html = '<table>';
    for (var i=0; i<c_profile.target_low.length; i++) {
      html += addBGLine(i);
    }
    html += '<tr><td></td><td></td><td></td><td><img class="addtargetbg" style="cursor:pointer" title="Add new interval before" src="'+icon_add+'" pos="'+i+'" href="#"></td></tr>';
    html += '</table>';
    $('#pe_targetbg_placeholder').html(html);
    
    $('.addtargetbg').click(function addtargetbg_click() {
      var pos = $(this).attr('pos');
      GUIToObject(); 
      c_profile.target_low.splice(pos,0,{time:'00:00',value:0});
      c_profile.target_high.splice(pos,0,{time:'00:00',value:0});
      return fillTimeRanges();
    });

    $('.deltargetbg').click(function deltargetbg_click() {
      var pos = $(this).attr('pos');
      GUIToObject(); 
      c_profile.target_low.splice(pos,1);
      c_profile.target_high.splice(pos,1);
      c_profile.target_low[0].time = '00:00';
      c_profile.target_high[0].time = '00:00';
      return fillTimeRanges();
    });

    $(".pe_selectabletime").change(fillTimeRanges);

    objectToGUI();
    if (event) {
      event.preventDefault();
    }
    return false;
  }
  
  // fill GUI with values from c_profile object
  function objectToGUI() {

    $('#pe_dia').val(c_profile.dia);
    $('#pe_time').val(moment(c_profile.startDate).format('HH:mm'));
    $('#pe_date').val(moment(c_profile.startDate).format('YYYY-MM-DD'));
    $('#pe_hr').val(c_profile.carbs_hr);
    $('#pe_perGIvalues').prop('checked', c_profile.perGIvalues);
    $('#pe_hr_high').val(c_profile.carbs_hr_high);
    $('#pe_hr_medium').val(c_profile.carbs_hr_medium);
    $('#pe_hr_low').val(c_profile.carbs_hr_low);
    $('#pe_delay_high').val(c_profile.delay_high);
    $('#pe_delay_medium').val(c_profile.delay_medium);
    $('#pe_delay_low').val(c_profile.delay_low);
    $('#pe_timezone').val(c_profile.timezone);
 
    var index;
    [ { prefix:'pe_basal', array:'basal' },
      { prefix:'pe_ic',    array:'carbratio' },
      { prefix:'pe_isf',   array:'sens' }
    ].forEach(function (e) {
      for (index=0; index<c_profile[e.array].length; index++) {
        $('#'+e.prefix+'_from_'+index).val(c_profile[e.array][index].time);
        $('#'+e.prefix+'_val_'+index).val(c_profile[e.array][index].value);
      }
    });
    
    for (index=0; index<c_profile.target_low.length; index++) {
      $('#pe_targetbg_from_'+index).val(c_profile.target_low[index].time);
      $('#pe_targetbg_low_'+index).val(c_profile.target_low[index].value);
      $('#pe_targetbg_high_'+index).val(c_profile.target_high[index].value);
    }
    console.info(JSON.stringify(c_profile));
  }
  
  // Grab values from html GUI to object
  function GUIToObject() {
 
    c_profile.dia = parseFloat($('#pe_dia').val());
    c_profile.startDate = new Date(Nightscout.client.utils.mergeInputTime($('#pe_time').val(), $('#pe_date').val()));
    c_profile.carbs_hr = parseInt($('#pe_hr').val());
    c_profile.delay = 20;
    c_profile.perGIvalues = $('#pe_perGIvalues').is(':checked');
    c_profile.carbs_hr_high = parseInt($('#pe_hr_high').val());
    c_profile.carbs_hr_medium = parseInt($('#pe_hr_medium').val());
    c_profile.carbs_hr_low = parseInt($('#pe_hr_low').val());
    c_profile.delay_high = parseInt($('#pe_delay_high').val());
    c_profile.delay_medium = parseInt($('#pe_delay_medium').val());
    c_profile.delay_low = parseInt($('#pe_delay_low').val());
    c_profile.timezone = $('#pe_timezone').val();
 
    var index;
    [ { prefix:'pe_basal', array:'basal' },
      { prefix:'pe_ic',    array:'carbratio' },
      { prefix:'pe_isf',   array:'sens' }
    ].forEach(function (e) {
      for (index=0; index<c_profile[e.array].length; index++) {
        c_profile[e.array][index].time = $('#'+e.prefix+'_from_'+index).val();
        c_profile[e.array][index].value = parseFloat($('#'+e.prefix+'_val_'+index).val());
      }
    });
    
    for (index=0; index<c_profile.target_low.length; index++) {
      c_profile.target_low[index].time = $('#pe_targetbg_from_'+index).val();
      c_profile.target_low[index].value = parseFloat($('#pe_targetbg_low_'+index).val());
      c_profile.target_high[index].time = $('#pe_targetbg_from_'+index).val();
      c_profile.target_high[index].value = parseFloat($('#pe_targetbg_high_'+index).val());
    }
  }
  
  function toMinutesFromMidnight(time) {
    var split = time.split(':');
    return parseInt(split[0])*60 + parseInt(split[1]);
  }
  
  function toTimeString(minfrommidnight) {
    var time = moment().startOf('day').add(minfrommidnight,'minutes').format('HH:mm');
    return time;
  }
  
  function profileSubmit(event) {
    GUIToObject();
    if (new Date(c_profile.startDate) > new Date()) {
      alert('Date must be set in the past');
      $('#pe_status').hide().html('Wrong date').fadeIn("slow");
      return false;
    }
    
    if (!Nightscout.client.hashauth.isAuthenticated()) {
      alert(translate('Your device is not authenticated yet'));
      return false;
    }
    
    c_profile.units = serverSettings.settings.units;
    
    var xhr, dataJson;
    
    if ($('#pe_submit').text().indexOf('Create new record')>-1) {
      if (mongoprofiles.length > 1 && (new Date(c_profile.startDate) <= new Date(mongoprofiles[1].validfrom))) {
        alert('Date must be greater than last record '+new Date(mongoprofiles[1].startDate));
        $('#pe_status').hide().html('Wrong date').fadeIn("slow");
        return false;
      }
      
      // remove _id when creating new record
      delete c_profile._id;
      
      dataJson = JSON.stringify(c_profile, null, ' ');

      xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v1/profile/', true);
      xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
      xhr.setRequestHeader('api-secret', Nightscout.client.hashauth.hash());
      xhr.onload = function () {
        $('#pe_status').hide().text(xhr.statusText).fadeIn("slow");
        if (xhr.statusText==='OK') {
          var newprofile = _.cloneDeep(c_profile);
          mongoprofiles.unshift(newprofile);
          initeditor();
        }
      }
      xhr.send(dataJson);
    } else {
      // Update record
      dataJson = JSON.stringify(c_profile, null, ' ');

      xhr = new XMLHttpRequest();
      xhr.open('PUT', '/api/v1/profile/', true);
      xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
      xhr.setRequestHeader('api-secret', Nightscout.client.hashauth.hash());
      xhr.onload = function () {
        $('#pe_status').hide().text(xhr.statusText).fadeIn("slow");
      }
      xhr.send(dataJson);
    }
    
    if (event) {
      event.preventDefault();
    }
    return false;
  }

})();