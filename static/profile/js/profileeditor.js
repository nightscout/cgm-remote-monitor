(function () {
  'use strict';
  //for the tests window isn't the global object
  var $ = window.$;
  var _ = window._;
  var moment = window.moment;
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;

  var c_profile = null;

  //some commonly used selectors
  var peStatus = $('.pe_status');
  var timezoneInput = $('#pe_timezone');
  var databaseRecords = $('#pe_databaserecords');
  var timeInput = $('#pe_time');
  var dateInput = $('#pe_date');

  if (serverSettings === undefined) {
    console.error('server settings were not loaded, will not call init');
  } else {
    client.init(serverSettings, Nightscout.plugins);
  }
  
  var translate = client.translate;

  var defaultprofile = {
      //General values
      'dia':3,

      'carbratio': [
        {
          'time': '00:00',
          'value': 30
        }]
      , 'carbs_hr': 20
      , 'delay': 20
      , 'sens': [
        {
          'time': '00:00',
          'value': 100
        }]
      , 'timezone': 'UTC'

      //perGIvalues style values
      , 'perGIvalues': false
      , 'carbs_hr_high': 30
      , 'carbs_hr_medium': 30
      , 'carbs_hr_low': 30
      , 'delay_high': 15
      , 'delay_medium': 20
      , 'delay_low': 20

      , 'basal':[
        {
          'time': '00:00',
          'value': 0.1
        }]
      , 'target_low':[
        {
          'time': '00:00',
          'value': 0
        }]
      , 'target_high':[
        {
          'time': '00:00',
          'value': 0
        }]
      ,startDate: new Date(0).toISOString()
  };

//  , 'startDate': new Date()
//  defaultprofile.startDate.setSeconds(0);
//  defaultprofile.startDate.setMilliseconds(0);

  var icon_add = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABa0lEQVQ4T6WTzysEYRjHP+/Mrv2hHOTuqJRNOfgPSORHokg4OClHcnVzVygHF6WIcuHMnyCHVRyI3ZYxa23vzOzs7LzamaI0e5i89fTWt/f5vPV5n1cQsXLbHepvfLv5JaLORoZNwMbyFo5vYfsWB0c7xAasLa5T/vCg45Oj48P4gJWFVYxCA63L5PzkND5gfm4Jo+Chd5W5OrtsDYgS1pQ1OTuNUfTQO8tcX9xE+QugYnS/X81MzGP7MpTWkEFVZY1KxcVPV3h27zAtA+oCagIcDfWUCgEje31qfHwK06gHjaF5iXQcHCV5lHmqqgQCNEAI0IsavCVDwNBurxoeGwmaAkDDwvYsqtIh//6AJUoklP97s62BbJYeAqIcpJNZsoM+r2aVbKKOekiBL8An3BuAEiGg1SSKAYnttpFxPdR9Jv4zipxFTUuQKqsfYbFGWfTYuO06yRfxIyweoLuG+iMsFuBfvzFy7FqE33vs2BFqlfN5AAAAAElFTkSuQmCC';
  var icon_remove = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACrElEQVQ4T42Ty2sTQRzHv5tmk2yyjRNtpfZhL8V6s2KoUNC2XqwgaCsVQcGiFqpHi0c9iRdR/ANE9KR40FIQX4cueKoPaKFoLdSYNtE0abKT1+5s9iW7aUMiHtzTzO7v85md+c6PA4DrHbsPCKIgOWO1pA7dT6YXnXH949SE/F63pqwZtRrO+SCKgjQ5NUV+azpmHj2krMwaJC4c8Erj+/eRyloMMwWFKgbn1nC3ervlK1evkXBLGBZT8SOewotnTylTNLdgeg/pDgZDC2cPHSR8bB22DVC9hFe0SG/H0xFXcHlykjRHRDBWgJcZSCY38Xx2lhqMnRYE34Px/sN9vlQWeoHBAx2yXsRruVAVuFsIBaSJ8+eJGPaBqQV4NROJjTzez89jLBoFn6FgybQL54wS3uTyVDFQ3cL2IYpBv3RhdJSIIQ80tQyv7gEqJvS8AmUlBs7UXPhtjtZgh3UFNYngk86NHCfNAg9dMwHVBPu+CpsVkTXKeJeVG+AGgTOZ3tt6MSKKjy+NjEBjFrR4ElZmA4pdxstMFsyyJu6tZZ7Ux9vwB6EAL50ZGiRECEPPUOixVTRxHlicgSVWxEdZpuZWfNuS2hk48NjwMIkIYZglBnV5Cbqtws/5IaAJmsfCglrEl2y2QeKmEBJ80tixKmxrFpSVr0gV0viQoxho2YUuPohmeFD22PiklLC4ma5JuBvdrfLJI0dJd0s7bM0ES8aR/BXDXGaTskqlL+D3Lwy0tZEePoAd4EA5YF4tYymdonfjmQh3s6dTPjU4SHYGwjAKecSXFyGlM1TdytntE56T+ts7SC/vhw3gm6njc2Kd3vm5Ub1IwQAvnYhGiZpYw1wiWYPrIw7wnBTt7CLOOwdmut14kQQvqt24tfK/utGR6LaF+iRqMf4N/O/8D28HiiCRYqzAAAAAAElFTkSuQmCC';
  //var icon_clone = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACSklEQVQ4T5VTYU9SYRR+zn0vXhDEFyRBXcpmbZnZsOXsI2xpVnNcv/ilufET8h/oL8h/gN/aWhs2yjKt26rPSvUh5yQodQlqgKQCd5fbLg2jxlycT+/OOc85z/OcvYSa8MoRLqimUEuzOSgwBl0nFFUtW1K1J/Ho6Hxtr/H2yQqnarJ3fFHucNnC57tdXIUJhydl6CAwIhwfFXCwf5hUC6XpjYXAQgUcUngRzkxlgHc0Kl+57I443S7s5VQwxqCVCYVSGfkTFSQQmsQmHGVzKJ78nJMs2izBohRg8ZFB293iSPQPdPOiqiOdyiGdysdKmp4t64LXxlu9otUKTVdhkSSUjgooHOez7R1uvr2bA10cfx66cb0n3GS14tPHrWz6R34i+fT2m6q0rruv7tvs9gdOtxNk0mA2SRB0gqVZwGb8AOSbXIkMDV+Qt7cy2IinJ+LRWxWNf5ur+Kx2vub0OABRg2QSIYqEr/EMaHjqrdJ/tce/upqIxR76B/8FVzySFc7MzWvtnW6vyjSAAFFgyBkSrt17n7jU1+ldjcVn1x+PzNTZzkWLTXF5zvmYmaEslCEIxnUE7H07AA1NvVPaO9r8X5Kpic+Pfp+oNvpCH/R6rKo5GphUIq1Oh7y++T2wv/LHvLNAtTXqHX8Zkqyt4XQ6M73/emzuf4GnDLg/wu0tbYliqTifWhqZbniAAfCMLs/oRMHU0s26VzjTA6PI/QqXJC1BxAZ3XwSSjbA4/UyesWU/Y2Jw51mgIRmnA4ytXXcU385iINYIg1+OJdcoyf/hkgAAAABJRU5ErkJggg==';
  //var icon_apply = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACh0lEQVQ4T5XSXUhTYRgH8P85O+fMOZ3H2WButc7MD3AQWyaYIRZEqANpt9HHCiwvIhWim8gPiqArJailVmdhJGEI3USk4rAQc1MnTdMitZhtfm86ncvcYhMls2i9l+/Hj//zvA+B/1kmcKSArGIohmNIZoIMkRVE1O95sOQaOXCCK+KUYgWcy99gne2zRA1Q9VR1/u7DVcVcIdyrLshFCtQPNyIqgG6gtWImduB69lVM+r9EQqvEajQM8dEBokcxnSWas0fSElMw5B1EdlIuLM43GJxz1P0zgfhhjDFDmsFf1pVixOeASqTGgt+Llk+tEwCt2wDuQgsSWghgxwXYNxvL8iwbIoLjN3KvsQQVRCAUgIyWg3c0wRdYPmoz2C0E7qE2NUFdnpa4D73TfZgLLNThIirCCGuW8MWpRcYC9TF8DYwhPU6DtvEO2Kb666zF9sidMBC6lVsJES1EiCDwZPQZHHMfzBJB7ONdcbLOm3mVcP9wQi5UwO2bQdP7pxOi9aDOYrB7NgATQnfyb2Mq4AJN0eDiU9A82oL+6UFcyS7DXqkSfixDKpDB1P8Ai98Xdd1661aZBO6jNif5YPm5zFOYXZsCQzHYE8dhZP4jspK1mAm6oYpR49Xn1+iZtNW81fdU/zp8kSaSDSSfpzxkPK85jfn1WawSK9BI9mMJXkiFSXAvzYAfMNu79O90v0/u1jdKzPER5IzmJLyhefiJFchFyWApKUzWRnj8Hp1F370VfRPaNgfKZgWfIlEZL2WVQsAASUIZ2sY60Ou01bQXdm2L/kcgvJn5PJ3nElTG0qwSuHwutAy32tsLunZE/ysQPsh5caCaoYRlQgHjoUnC8PK4ZUf0TeAnGJ/iJEGClrwAAAAASUVORK5CYII=';
  
  var mongorecords = [];
  var currentrecord = 0;
  var currentprofile = null;
  var dirty = false;

  // Fetch data from mongo
  peStatus.hide().text(translate('Loading profile records ...')).fadeIn('slow');
  $.ajax('/api/v1/profile.json', {
    success: function (records) {
      if (!records.length) {
        records.push(defaultprofile);
      }
      client.profilefunctions.loadData(records); // do a conversion if needed
      mongorecords = client.profilefunctions.data;
      // create new profile to be edited from last record
      if (mongorecords.length) {
        _.each(mongorecords, function eachMongoProfile (mongoprofile) {
          _.each(mongoprofile.store, function eachStoredProfile (p) {
            // allign with default profile
            for (var key in defaultprofile) {
              if (defaultprofile.hasOwnProperty(key) && !p.hasOwnProperty(key)) {
                  p[key] = defaultprofile[key];
              }
            }
            for (key in p) {
              if (p.hasOwnProperty(key) && !defaultprofile.hasOwnProperty(key)) {
                  delete p[key];
              }
            }
            convertToRanges(p);
          });
        });
        
        peStatus.hide().text(translate('Values loaded.')).fadeIn('slow');
      } else {
        mongorecords.push({
          defaultProfile: 'Default'
          , store : {
            'Default': _.cloneDeep(defaultprofile)
          }
          , startDate: new Date().toISOString()
        });
        peStatus.hide().text(translate('Default values used.')).fadeIn('slow');
      }
    },
    error: function () {
      mongorecords.push({
        defaultProfile: 'Default'
        , store : {
          'Default': _.cloneDeep(defaultprofile)
        }
        , startDate: new Date().toISOString()
      });
      peStatus.hide().text(translate('Error. Default values used.')).fadeIn('slow');
    }
  }).done(initeditor);
  
  // convert simple values to ranges if needed
  function convertToRanges(profile) {
    if (typeof profile.carbratio !== 'object') { profile.carbratio = [{ 'time': '00:00', 'value': profile.carbratio }]; }
    if (typeof profile.sens !== 'object') { profile.sens = [{ 'time': '00:00', 'value': profile.sens }]; }
    if (typeof profile.target_low !== 'object') { profile.target_low = [{ 'time': '00:00', 'value': profile.target_low }]; }
    if (typeof profile.target_high !== 'object') { profile.target_high = [{ 'time': '00:00', 'value': profile.target_high }]; }
    if (typeof profile.basal !== 'object') { profile.basal = [{ 'time': '00:00', 'value': profile.basal }]; }
    if (profile.target_high.length !== profile.target_low.length) {
      window.alert(translate('Time ranges of target_low and target_high don\'t  match. Values are restored to defaults.'));
      profile.target_low = _.cloneDeep(defaultprofile.target_low);
      profile.target_high = _.cloneDeep(defaultprofile.target_high);
    }
  }
  
  function initeditor() {
    $('#pe_history').toggle(client.settings.extendedSettings.profile && client.settings.extendedSettings.profile.history);
    $('#pe_multiple').toggle(client.settings.extendedSettings.profile && client.settings.extendedSettings.profile.multiple);
    
    // Load timezones
    timezoneInput.empty();
    moment.tz.names().forEach(function addTz(tz) {
      timezoneInput.append('<option value="' + tz + '">' + tz + '</option>');
    });

    $('#pe_form').find('button').click(profileSubmit);
    
    $('#pe_profiles').unbind().bind('change', profileChange);
    $('#pe_profile_add').unbind().bind('click', profileAdd);
    $('#pe_profile_remove').unbind().bind('click', profileRemove);
    $('#pe_profile_clone').unbind().bind('click', profileClone);

    $('#pe_databaserecords').unbind().bind('change',recordChange);
    $('#pe_records_add').unbind().bind('click', recordAdd);
    $('#pe_records_remove').unbind().bind('click', recordRemove);
    $('#pe_records_clone').unbind().bind('click', recordClone);

    // Add handler for style switching
    $('#pe_perGIvalues').unbind().on('change', switchStyle);

    // display status
    $('#pe_units').text(client.settings.units);
    $('#pe_timeformat').text(client.settings.timeFormat+'h');
    $('#pe_title').text(client.settings.customTitle);

    currentprofile = mongorecords[currentrecord].defaultProfile;
    
    // prepare basal profiles
    initRecord();
    // hide unused style of ratios
    switchStyle();
    
    console.log('Done initeditor()');
  }
  
  function initRecord() {
    databaseRecords.empty();
    for (var r = 0; r < mongorecords.length; r++ ) {
      databaseRecords.append('<option value="' + r + '">' + translate('Valid from:') + ' ' + new Date(mongorecords[r].startDate).toLocaleString() + '</option>');
    }
    databaseRecords.val(currentrecord);
    
    timeInput.val(moment(mongorecords[currentrecord].startDate).format('HH:mm'));
    dateInput.val(moment(mongorecords[currentrecord].startDate).format('YYYY-MM-DD'));
  
    initProfile();
  }
  
  function initProfile() {
    var record = mongorecords[currentrecord];
    // fill profilenames
    $('#pe_profiles').empty();
    
    for (var key in record.store) {
      if (record.store.hasOwnProperty(key)) {     
        $('#pe_profiles').append('<option value="' + key + '">' + key + '</option>');
      }
    }
    
    $('#pe_profiles').val(currentprofile);
    $('#pe_profile_name').val(currentprofile);

    c_profile = mongorecords[currentrecord].store[currentprofile];
    mongorecords[currentrecord].defaultProfile = currentprofile;
    // Set values from profile to html
    fillTimeRanges();
  }
  
  // Handling of record list box change
  function recordChange (event) {
    if (dirty && window.confirm(translate('Save current record before switching to new?'))) {
      profileSubmit();
    }
    currentrecord = databaseRecords.val();
    currentprofile = mongorecords[currentrecord].defaultProfile;
    initRecord();
    dirty = false;
    maybePreventDefault(event);
  }

  function recordAdd (event) {
    if (dirty && window.confirm(translate('Save current record before switching to new?'))) {
      profileSubmit();
    }
    mongorecords.push({
      startDate: new Date().toISOString()
      , defaultProfile: 'Default'
      , store: {
        'Default' : _.cloneDeep(defaultprofile)
      }
    });
    currentrecord = mongorecords.length - 1;
    currentprofile = 'Default';
    initRecord();
    dirty = true;
    maybePreventDefault(event);
  }

  function recordRemove (event) {
    if (mongorecords.length > 1 && window.confirm(translate('Delete record')+'?')) {
      if (mongorecords[currentrecord]._id) {
        $.ajax({
          method: 'DELETE'
          , url: '/api/v1/profile/'+mongorecords[currentrecord]._id
          , headers: {
            'api-secret': client.hashauth.hash()
          }
        }).done(function postSuccess () {
          console.info('profile deleted');
          peStatus.hide().text(status).fadeIn('slow');
          mongorecords.splice(currentrecord,1);
          currentrecord = 0;
          currentprofile = mongorecords[currentrecord].defaultProfile;
          initRecord();
          dirty = false;
        }).fail(function(xhr, status, errorThrown)  {
          console.error('Profile not removed', status, errorThrown);
          peStatus.hide().text(status).fadeIn('slow');
        });
      } else {
          mongorecords.splice(currentrecord,1);
          currentrecord = 0;
          currentprofile = mongorecords[currentrecord].defaultProfile;
          initRecord();
          dirty = false;
      }
    }
    maybePreventDefault(event);
    return false;
  }

  function recordClone (event) {
    if (dirty && window.confirm(translate('Save current record before switching to new?'))) {
      profileSubmit();
    }
    GUIToObject();
    mongorecords.push(_.cloneDeep(mongorecords[currentrecord]));
    currentrecord = mongorecords.length - 1;
    mongorecords[currentrecord].startDate = new Date().toISOString();
    currentprofile = mongorecords[currentrecord].defaultProfile;
    delete mongorecords[currentrecord]._id;
    initRecord();
    dirty = true;
    
    maybePreventDefault(event);
  }

  // Handling of profile list box change
  function profileChange (event) {
    var record = mongorecords[currentrecord];
    var newpr = $('#pe_profiles').val();
    // copy values from html to c_profile
    GUIToObject();
    
    var newname = $('#pe_profile_name').val();
    if (currentprofile !== newname) {
      // rename if already exists
      while (record.store[newname]) {
        newname += '1';
      }
      record.store[newname] = record.store[currentprofile];
      delete record.store[currentprofile];
      dirty = true;
    }
    if (newpr === currentprofile) { // fake call to update values
      newpr = newname;
    }
    currentprofile = newpr;
    initProfile();

    maybePreventDefault(event);
    return false;
  }
  
  function profileAdd (event) {
    var record = mongorecords[currentrecord];
    var newname = 'New profile';
    while (record.store[newname]) {
      newname += '1';
    }
    record.store[newname] = _.cloneDeep(defaultprofile);
    currentprofile = newname;
    dirty = true;

    initProfile();
    maybePreventDefault(event);
    return false;
  }
  
  function profileRemove (event) {
    var record = mongorecords[currentrecord];
    var availableProfile = getFirstAvailableProfile(record);
    if (availableProfile) {
      delete record.store[currentprofile];
      currentprofile = availableProfile;
      initProfile();
      dirty = true;
    }

    maybePreventDefault(event);
    return false;
  }
  
  function profileClone (event) {
    GUIToObject();
    var record = mongorecords[currentrecord];
    var newname = $('#pe_profile_name').val() + ' (copy)';
    while (record.store[newname]) {
      newname += '1';
    }
    record.store[newname] = _.cloneDeep(record.store[currentprofile]);
    currentprofile = newname;
    dirty = true;

    initProfile();
    maybePreventDefault(event);
    return false;
  }
  
  // Handling html events and setting/getting values
  function switchStyle(event) {
    if (!$('#pe_perGIvalues').is(':checked')) {
      $('#pe_simple').show('slow');
      $('#pe_advanced').hide('slow');
    } else {
      $('#pe_simple').hide('slow');
      $('#pe_advanced').show('slow');
    }
    maybePreventDefault(event);
  }
  
  function fillTimeRanges(event) {
    if (event) {
      GUIToObject();
    }
    
    function shouldAddTime(i, time, array) {
      if (i === 0 && time === 0) {
        return true;
      } else if (i === 0) {
        return false;
      } else {
        var minutesFromMidnight = toMinutesFromMidnight(c_profile[array][i - 1].time);
        return !isNaN(minutesFromMidnight) && minutesFromMidnight < time * 30;
      }
    }
 
    function addSingleLine(e,i) {
      var tr = $('<tr>');
      var select = $('<select>').attr('class','pe_selectabletime').attr('id',e.prefix+'_from_'+i);
      var lowest = -1;
      for (var t=0;t<48;t++) {
        if (shouldAddTime(i, t, e.array)) {
          if (lowest === -1) { lowest = t*30; }
          select.append('<option value="' + toTimeString(t*30) + '">' + toDisplayTime(t*30) + '</option>');
        }
      }
      var selectedValue = toMinutesFromMidnight(c_profile[e.array][i].time) * 30;
      select.val(selectedValue);

      tr.append($('<td>').append(translate('From') + ': ').append(select));
      tr.append($('<td>').append(e.label).append($('<input type="text">').attr('id',e.prefix+'_val_'+i).attr('value',c_profile[e.array][i].value)));
      var icons_td = $('<td>').append($('<img>').attr('class','addsingle').attr('style','cursor:pointer').attr('title',translate('Add new interval before')).attr('src',icon_add).attr('array',e.array).attr('pos',i));
      if (c_profile[e.array].length>1) {
        icons_td.append($('<img>').attr('class','delsingle').attr('style','cursor:pointer').attr('title',translate('Delete interval')).attr('src',icon_remove).attr('array',e.array).attr('pos',i));
      }
      tr.append(icons_td);
        
      if (lowest>toMinutesFromMidnight(c_profile[e.array][i].time)) {
        c_profile[e.array][i].time = toTimeString(lowest);
      }
      return tr[0].outerHTML;
    }
    
    // Fill dropdown boxes
    _.each([{prefix:'pe_basal', array:'basal', label: translate('Basal rate') + ' : '},
     {prefix:'pe_ic', array:'carbratio', label: translate('I:C') + ' : '},
     {prefix:'pe_isf', array:'sens', label: translate('ISF') + ' : '}
    ], function (e) {
      var html = '<table>';
      for (var i=0; i<c_profile[e.array].length; i++) {
        html += addSingleLine(e,i);
      }
      html += '<tr><td></td><td></td><td><img class="addsingle" style="cursor:pointer" title="' + translate('Add new interval before') + '" src="'+icon_add+'" array="'+e.array+'" pos="'+i+'" href="#"></td></tr>';
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
        if (shouldAddTime(i, t, 'target_low')) {
          if (lowesttime === -1) { lowesttime = t*30; }
          select.append('<option value="' + toTimeString(t*30) + '">' + toDisplayTime(t*30) + '</option>');
        }
      }
      var selectedValue = toMinutesFromMidnight(c_profile.target_low[i].time) * 30;
      select.val(selectedValue);
      tr.append($('<td>').append(translate('From') + ': ').append(select));
      tr.append($('<td>').append(translate('Low') + ' : ').append($('<input type="text">').attr('id','pe_targetbg_low_'+i).attr('value',c_profile.target_low[i].value)));
      tr.append($('<td>').append(translate('High') + ' : ').append($('<input type="text">').attr('id','pe_targetbg_high_'+i).attr('value',c_profile.target_high[i].value)));
      var icons_td = $('<td>').append($('<img>').attr('class','addtargetbg').attr('style','cursor:pointer').attr('title',translate('Add new interval before')).attr('src',icon_add).attr('pos',i));
      if (c_profile.target_low.length>1) {
        icons_td.append($('<img>').attr('class','deltargetbg').attr('style','cursor:pointer').attr('title',translate('Delete interval')).attr('src',icon_remove).attr('pos',i));
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
    html += '<tr><td></td><td></td><td></td><td><img class="addtargetbg" style="cursor:pointer" title="' + translate('Add new interval before') + '" src="'+icon_add+'" pos="'+i+'" href="#"></td></tr>';
    html += '</table>';
    $('#pe_targetbg_placeholder').html(html);
    
    $('.addtargetbg').click(function addtargetbg_click() {
      var pos = $(this).attr('pos');
      GUIToObject(); 
      c_profile.target_low.splice(pos,0,{time:'00:00',value:0});
      c_profile.target_high.splice(pos,0,{time:'00:00',value:0});
      dirty = true;
      return fillTimeRanges();
    });

    $('.deltargetbg').click(function deltargetbg_click() {
      var pos = $(this).attr('pos');
      GUIToObject(); 
      c_profile.target_low.splice(pos,1);
      c_profile.target_high.splice(pos,1);
      c_profile.target_low[0].time = '00:00';
      c_profile.target_high[0].time = '00:00';
      dirty = true;
      return fillTimeRanges();
    });

    $('.pe_selectabletime').unbind().on('change', fillTimeRanges);

    objectToGUI();
    maybePreventDefault(event);
    return false;
  }
  
  // fill GUI with values from c_profile object
  function objectToGUI() {

    $('#pe_dia').val(c_profile.dia);
    $('#pe_hr').val(c_profile.carbs_hr);
    $('#pe_perGIvalues').prop('checked', c_profile.perGIvalues);
    $('#pe_hr_high').val(c_profile.carbs_hr_high);
    $('#pe_hr_medium').val(c_profile.carbs_hr_medium);
    $('#pe_hr_low').val(c_profile.carbs_hr_low);
    $('#pe_delay_high').val(c_profile.delay_high);
    $('#pe_delay_medium').val(c_profile.delay_medium);
    $('#pe_delay_low').val(c_profile.delay_low);
    timezoneInput.val(c_profile.timezone);
 
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
    //console.info(JSON.stringify(c_profile));
  }
  
  // Grab values from html GUI to object
  function GUIToObject() {
    var oldProfile = _.cloneDeep(c_profile);
    
    c_profile.dia = parseFloat($('#pe_dia').val());
    c_profile.carbs_hr = parseInt($('#pe_hr').val());
    c_profile.delay = 20;
    c_profile.perGIvalues = $('#pe_perGIvalues').is(':checked');
    c_profile.carbs_hr_high = parseInt($('#pe_hr_high').val());
    c_profile.carbs_hr_medium = parseInt($('#pe_hr_medium').val());
    c_profile.carbs_hr_low = parseInt($('#pe_hr_low').val());
    c_profile.delay_high = parseInt($('#pe_delay_high').val());
    c_profile.delay_medium = parseInt($('#pe_delay_medium').val());
    c_profile.delay_low = parseInt($('#pe_delay_low').val());
    c_profile.timezone = timezoneInput.val();
 
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
      var input = $('#pe_targetbg_from_' + index);
      c_profile.target_low[index].time = input.val();
      c_profile.target_low[index].value = parseFloat($('#pe_targetbg_low_'+index).val());
      c_profile.target_high[index].time = input.val();
      c_profile.target_high[index].value = parseFloat($('#pe_targetbg_high_'+index).val());
    }
    
    c_profile.units = client.settings.units;

    if (!_.isEqual(oldProfile,c_profile)) {
      dirty = true;
    }
  }
  
  function toMinutesFromMidnight(time) {
    var split = time.split(':');
    return parseInt(split[0])*60 + parseInt(split[1]);
  }
  
  function toTimeString(minfrommidnight) {
    return moment().startOf('day').add(minfrommidnight,'minutes').format('HH:mm');
  }

  function toDisplayTime (minfrommidnight) {
    var time = moment().startOf('day').add(minfrommidnight,'minutes');
    return client.settings.timeFormat === 24 ? time.format('HH:mm') : time.format('h:mm A');
  }
  
  function profileSubmit(event) {
    if (!client.hashauth.isAuthenticated()) {
      window.alert(translate('Your device is not authenticated yet'));
      return false;
    }

    profileChange(event);
    var record = mongorecords[currentrecord];
    record.startDate = new Date(client.utils.mergeInputTime(timeInput.val(), dateInput.val())).toISOString( );
    
    var adjustedRecord = _.cloneDeep(record);

    for (var key in adjustedRecord.store) {
      if (adjustedRecord.store.hasOwnProperty(key)) {
        var profile = adjustedRecord.store[key];
        if (!profile.perGIvalues) {
          delete profile.perGIvalues;
          delete profile.carbs_hr_high;
          delete profile.carbs_hr_medium;
          delete profile.carbs_hr_low;
          delete profile.delay_high;
          delete profile.delay_medium;
          delete profile.delay_low;
        }
      }
    }
    adjustedRecord.defaultProfile = currentprofile;
    
    if (record.convertedOnTheFly) {
      var result = window.confirm(translate('Profile is going to be saved in newer format used in Nightscout 0.9.0 and above and will not be usable in older versions anymore.\nAre you sure?'));
      if (!result) {
        return;
      }
    }
    
    delete record.convertedOnTheFly;
    delete adjustedRecord.convertedOnTheFly;

    console.info('saving profile');
    
    $.ajax({
      method: 'PUT'
      , url: '/api/v1/profile/'
      , data: adjustedRecord
      , headers: {
        'api-secret': client.hashauth.hash()
      }
    }).done(function postSuccess (data, status) {
      console.info('profile saved', data);
      peStatus.hide().text(status).fadeIn('slow');
      record._id = data._id;
      initRecord();
      dirty = false;
    }).fail(function(xhr, status, errorThrown)  {
      console.error('Profile not saved', status, errorThrown);
      peStatus.hide().text(status).fadeIn('slow');
    });
    return false;
  }
  
  function getFirstAvailableProfile(record) {
    var availableProfiles = [];
    for (var key in record.store) {
      if (record.store.hasOwnProperty(key)) {     
        if (key !== currentprofile) {
          availableProfiles.push(key);
        }
      }
    }
    return availableProfiles.length ? availableProfiles[0] : null;
  }
  
  function maybePreventDefault (event) {
    if (event) {
      event.preventDefault();
    }
  }

})();
