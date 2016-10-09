'use strict';

//for the tests window isn't the global object
var $ = window.$;
var _ = window._;
var Nightscout = window.Nightscout;
var client = Nightscout.client;

(function () {

client.init(Nightscout.plugins, function loaded () {
  var translate = client.translate;
  
  var foodrec_template = { 
      _id: ''
    , type: 'food'
    , category: ''
    , subcategory: ''
    , name: ''
    , portion: 0
    , carbs: 0
    , gi: 2
    , unit: 'g'
  };

  var foodunits = ['g', 'ml', 'pcs', 'oz'];
  
  var foodrec = _.cloneDeep(foodrec_template);

  var HIDDEN = 99999;
  var quickpickrec_template = { 
      _id: ''
    , type: 'quickpick'
    , name: ''
    , foods: []
    , carbs: 0
    , hideafteruse: true
    , hidden: false
    , position: HIDDEN
  };

  var filter = {
      category: ''
    , subcategory: ''
    , name: ''
  };
  
  //https://www.iconfinder.com/iconsets/musthave
  //var icon_add = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABa0lEQVQ4T6WTzysEYRjHP+/Mrv2hHOTuqJRNOfgPSORHokg4OClHcnVzVygHF6WIcuHMnyCHVRyI3ZYxa23vzOzs7LzamaI0e5i89fTWt/f5vPV5n1cQsXLbHepvfLv5JaLORoZNwMbyFo5vYfsWB0c7xAasLa5T/vCg45Oj48P4gJWFVYxCA63L5PzkND5gfm4Jo+Chd5W5OrtsDYgS1pQ1OTuNUfTQO8tcX9xE+QugYnS/X81MzGP7MpTWkEFVZY1KxcVPV3h27zAtA+oCagIcDfWUCgEje31qfHwK06gHjaF5iXQcHCV5lHmqqgQCNEAI0IsavCVDwNBurxoeGwmaAkDDwvYsqtIh//6AJUoklP97s62BbJYeAqIcpJNZsoM+r2aVbKKOekiBL8An3BuAEiGg1SSKAYnttpFxPdR9Jv4zipxFTUuQKqsfYbFGWfTYuO06yRfxIyweoLuG+iMsFuBfvzFy7FqE33vs2BFqlfN5AAAAAElFTkSuQmCC';
  var icon_remove = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACrElEQVQ4T42Ty2sTQRzHv5tmk2yyjRNtpfZhL8V6s2KoUNC2XqwgaCsVQcGiFqpHi0c9iRdR/ANE9KR40FIQX4cueKoPaKFoLdSYNtE0abKT1+5s9iW7aUMiHtzTzO7v85md+c6PA4DrHbsPCKIgOWO1pA7dT6YXnXH949SE/F63pqwZtRrO+SCKgjQ5NUV+azpmHj2krMwaJC4c8Erj+/eRyloMMwWFKgbn1nC3ervlK1evkXBLGBZT8SOewotnTylTNLdgeg/pDgZDC2cPHSR8bB22DVC9hFe0SG/H0xFXcHlykjRHRDBWgJcZSCY38Xx2lhqMnRYE34Px/sN9vlQWeoHBAx2yXsRruVAVuFsIBaSJ8+eJGPaBqQV4NROJjTzez89jLBoFn6FgybQL54wS3uTyVDFQ3cL2IYpBv3RhdJSIIQ80tQyv7gEqJvS8AmUlBs7UXPhtjtZgh3UFNYngk86NHCfNAg9dMwHVBPu+CpsVkTXKeJeVG+AGgTOZ3tt6MSKKjy+NjEBjFrR4ElZmA4pdxstMFsyyJu6tZZ7Ux9vwB6EAL50ZGiRECEPPUOixVTRxHlicgSVWxEdZpuZWfNuS2hk48NjwMIkIYZglBnV5Cbqtws/5IaAJmsfCglrEl2y2QeKmEBJ80tixKmxrFpSVr0gV0viQoxho2YUuPohmeFD22PiklLC4ma5JuBvdrfLJI0dJd0s7bM0ES8aR/BXDXGaTskqlL+D3Lwy0tZEePoAd4EA5YF4tYymdonfjmQh3s6dTPjU4SHYGwjAKecSXFyGlM1TdytntE56T+ts7SC/vhw3gm6njc2Kd3vm5Ub1IwQAvnYhGiZpYw1wiWYPrIw7wnBTt7CLOOwdmut14kQQvqt24tfK/utGR6LaF+iRqMf4N/O/8D28HiiCRYqzAAAAAAElFTkSuQmCC';
  var icon_edit = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABEUlEQVQ4jZ3MMUsCYQDG8ee8IySQbNCLyyEKG/RLNAXicqvQcAeNLrcFLlE0+xHuNpt8wy04rrYm8Q4HQRE56BSC3lSqU1BwCoxM39dnffj9BWyxXvVeEzvtctBwHyRebNu2Nk2lzMlrgJB+qBEeTByiKYpihl+fIO8jTI9PDJEVF1+K2iw+M6PhDuyag4NkQi/c3FkCK5Z3ZbM76qLltpCbn+vXxq0FABsDy9hzPdBvqvtXvvXzrw1swmsDLPjfACteGeDBfwK8+FdgGwwAIgC0ncsjxGRSH/eiPBgAJADY2z8sJ4JBfNBsDqlADVYMANIzKalv/bHaefKsTH9iPFb8ISsGAJym0+Qinz3jQktbAHcxvx3559eSAAAAAElFTkSuQmCC';
  var icon_up = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAH3SURBVDhPlZK/a1NRFMe/9/1KotLcwbYiipo2NqmDpTpoiJiguPgPCC7iYAcbYp0LxUGkxVr6Y6lgu6iLm4uCQszi4JS6FHQRFMRBDOJrcvPyEs+97+V3A+2Bw7nvcr6f973nXoZ+8RQTqCGn1hrSuIOCWneF5tfO8MWZ2Ax/NPmYB1kop/Z2iV6AL56O3eNj4TP4Lf7iVnSKm7ByWOuFdAJ88d14lp8Oj+P9jw/Y/vMFBgK4GbnNLUaQpU5Iawbt4gEpzqPiVmirprqi/BRKjo0XW5vFSkmkMevNxAM0bPvidyQuuwJuvUrbdTBWh6ZpGOOjEM4Onn/aKIoyQR6gwBriTHzGs/09j5Jbxo5rw67aEDWhfuOiCkM3cO7wWdQcB68+viyKfyKt4zq2s/H7/OJQEj9Lv6BrOkbCJ/H62xvYBHFAx2Aurh5LITJwAgfMIA6GDiEyPBL8/LVwg2GdPHbF/PllLGwtI2CYlBYsqteOp7H6dhFkxEvHqxqmyGB70szkeU2ya+l0eSQOmh5ECR9SzzzlE8oVsN53IKm0LQGmQRCTXBBAfitAV/QBMBLoTRfyKMqBtN0VfQFymAogXZB4Xw6YD9DJheGDDFrvHUDlytHLSB1J4tJwAonBCwSk1l0ArafciDm6Vtko07+qZrqUz9o1wH8prahHZgYc2gAAAABJRU5ErkJggg==';
  
  var foodlist = [];
  var foodquickpick = [];
  var foodquickpicktodelete = [];
  var showhidden = false;
  var categories = {};
  
  function restoreBoolValue(record,key) {
    if (typeof record[key] !== 'undefined') {
      record[key] = record[key] === 'true';
    }
  }
  
  // Fetch data from mongo
  $('#fe_status').hide().text('Loading food database ...').fadeIn('slow');
  $.ajax('/api/v1/food.json', {
    headers: client.headers()
    , success: function ajaxSuccess(records) {
      records.forEach(function processRecords(r) {
        restoreBoolValue(r,'hidden');
        restoreBoolValue(r,'hideafteruse');
        if (r.type === 'food') {
          foodlist.push(r);
          if (r.category && !categories[r.category]) {
            categories[r.category] = {};
          }
          if (r.category && r.subcategory) {
            categories[r.category][r.subcategory] = true;
          }
        } else if (r.type === 'quickpick') {
          calculateCarbs(foodquickpick.push(r)-1);
          console.log('Loaded quick pick: ',r);
        } else {
          console.log('Unknown food database record');
        }
      });
      $('#fe_status').hide().text(translate('Database loaded')).fadeIn('slow');
      foodquickpick.sort(function compare(a,b) { return cmp(parseInt(a.position),parseInt(b.position)) });
    }
    , error: function ajaxError() {
      $('#fe_status').hide().text(translate('Error: Database failed to load')).fadeIn('slow');
    }
  }).done(initeditor);
  
  function initeditor() {
    // Add handlers for gui
    $('#fe_editcreate').click(foodSubmit);
    $('#fe_clear').click(clearRec);
    $('#fe_id').change(updateSaveButton);
    $('#fe_quickpick_add').click(quickpickCreateRecord);
    $('#fe_quickpick_save').click(quickpickSave);
    $('#fe_filter_category').change(fillFilterSubcategories);
    $('#fe_filter_subcategory').change(doFilter);
    $('#fe_quickpick_showhidden').change(showHidden);
    $('#fe_filter_name').on('input',doFilter);
    $('#fe_category_list').change(function categoryListChange(event) { 
      $('#fe_category').val($('#fe_category_list').val()); 
      fillEditSubcategories(event);
    });
    $('#fe_subcategory_list').change(function subcategoryListChange(event) { 
      $('#fe_subcategory').val($('#fe_subcategory_list').val());
      event.preventDefault();
    });
    $('#fe_unit').empty();
    for (var u=0; u<foodunits.length; u++) {
      $('#fe_unit').append(new Option(translate(foodunits[u]),foodunits[u]));
    }
  
    // Set values from profile to html
    fillForm();
    // show proper submit button
    updateSaveButton();

    console.log('Done initeditor()');
  }
  
  function updateSaveButton(event) {
    if($('#fe_id').val()==='') {
      $('#fe_editcreate').text(translate('Create new record'));
    } else {
      $('#fe_editcreate').text(translate('Save record'));
    }
     maybePreventDefault(event);
  }
  
  function fillFilterSubcategories(event) {
    var s;
    maybePreventDefault(event,GUIToObject);

    filter.subcategory = '';
    $('#fe_filter_subcategory').empty().append(new Option(translate('(none)'),''));
    if (filter.category !== '') {
      for (s in categories[filter.category]) {
        if (categories[filter.category].hasOwnProperty(s)) {
          $('#fe_filter_subcategory').append(new Option(s,s));
        }
      }
    }
    doFilter();
  }
  
  function fillEditSubcategories(event) {
    maybePreventDefault(event,GUIToObject);

    var s;
    foodrec.subcategory = '';
    $('#fe_subcategory_list').empty().append(new Option(translate('(none)'),''));
    if (foodrec.category !== '') {
      for (s in categories[foodrec.category]) {
        if (categories[foodrec.category].hasOwnProperty(s)) {
          $('#fe_subcategory_list').append(new Option(s,s));
        }
      }
    }
    $('#fe_subcategory').val('');
  }
  
  function doEdit(event) {
    var index = $(this).attr('index');
    foodrec = _.cloneDeep(foodlist[index]);
    objectToGUI();
    updateSaveButton();
    maybePreventDefault(event);
    return false;
  }
  
  function updateFoodArray(newrec) {
    for (var i=0; i<foodlist.length; i++) {
      if (foodlist[i]._id === newrec._id) {
        foodlist[i] = _.cloneDeep(newrec);
        if (newrec.category && !categories[newrec.category]) {
          categories[newrec.category] = {};
        }
        if (newrec.category && newrec.subcategory) {
          categories[newrec.category][newrec.subcategory] = true;
        }
        return;
      }
    }
  }

  function fillForm(event) {
    $('#fe_filter_category').empty().append(new Option(translate('(none)'),''));
    $('#fe_category_list').empty().append(new Option(translate('(none)'),''));
    for (var s in categories) {
      if (categories.hasOwnProperty(s)) {
        $('#fe_filter_category').append(new Option(s,s));
        $('#fe_category_list').append(new Option(s,s));
      }
    }
    fillFilterSubcategories();
    drawQuickpick();
    
    objectToGUI();
    maybePreventDefault(event);
    return false;
  }
  
  function doFilter(event) {
    if (event) {
      GUIToObject();
    }

    $('#fe_data_header')
      .empty()
      .append($('<span>').attr('class','width50px'))
      .append($('<span>').attr('class','width200px').append(translate('Name')))
      .append($('<span>').attr('class','width150px').css('text-align','center').append(translate('Portion')))
      .append($('<span>').attr('class','width50px').css('text-align','center').append(translate('Unit')))
      .append($('<span>').attr('class','width100px').css('text-align','center').append(translate('Carbs')))
      .append($('<span>').attr('class','width100px').css('text-align','center').append(translate('GI')+' [1-3]'))
      .append($('<span>').attr('class','width150px').append(translate('Category')))
      .append($('<span>').attr('class','width150px').append(translate('Subcategory')));

    $('#fe_data').empty();
    
    for (var i=0; i<foodlist.length; i++) {
      if (filter.category !== '' && foodlist[i].category !== filter.category) { continue; }
      if (filter.subcategory !== '' && foodlist[i].subcategory !== filter.subcategory) { continue; }
      if (filter.name !== '' && foodlist[i].name.toLowerCase().indexOf(filter.name.toLowerCase()) < 0) { continue; }
      
      $('#fe_data')
        .append($('<div>').attr('index',i).addClass('draggablefood')
          .append($('<span>').addClass('width50px')
            .append($('<img>').attr('title',translate('Edit record')).attr('src',icon_edit).attr('index',i).attr('class','fe_editimg'))
            .append($('<img>').attr('title',translate('Delete record')).attr('src',icon_remove).attr('index',i).attr('class','fe_removeimg'))
          )
          .append($('<span>').addClass('width200px').append(foodlist[i].name))
          .append($('<span>').addClass('width150px').css('text-align','center').append(foodlist[i].portion))
          .append($('<span>').addClass('width50px').css('text-align','center').append(foodlist[i].unit))
          .append($('<span>').addClass('width100px').css('text-align','center').append(foodlist[i].carbs))
          .append($('<span>').addClass('width100px').css('text-align','center').append(foodlist[i].gi))
          .append($('<span>').addClass('width150px').append(foodlist[i].category))
          .append($('<span>').addClass('width150px').append(foodlist[i].subcategory))
        );
    }
    
    $('.fe_editimg').click(doEdit);
    $('.fe_removeimg').click(deleteFoodRecord);
    
    $('.draggablefood').draggable({
      helper: function keepDraggedSize(){
        return $(this).clone().width($(this).width()).height($(this).height());
      },
      scope: 'foodlist',
      revert: 'invalid'
    });
    maybePreventDefault(event);
  }
  
  function deleteQuickpickRecord(event) {
    var index = $(this).attr('index');
    foodquickpicktodelete.push(foodquickpick[index]._id);
    foodquickpick.splice(index,1);
    drawQuickpick();
    maybePreventDefault(event);
    return false;
  }
  
  function deleteFoodRecord(event) {
    var index = $(this).attr('index');
    deleteRecord(foodlist[index]._id);
    foodlist.splice(index,1);
    fillForm();
    maybePreventDefault(event);
    return false;
  }
  
  function showHidden(event) {
    GUIToObject();
    drawQuickpick();
    maybePreventDefault(event);
    return false;
  }
  
  function drawQuickpick() {
    
    function addHeaderOrHint(q,i) {
      if (q.foods.length) {
        $('#fe_qpfieldset_'+i)
          .append($('<span>').addClass('width50px'))
          .append($('<span>').addClass('width200px').append(translate('Name')))
          .append($('<span>').addClass('width150px').css('text-align','center').append(translate('Portion')))
          .append($('<span>').addClass('width100px').css('text-align','center').append(translate('Carbs')))
          .append($('<br>'));
      } else {
        $('#fe_qpfieldset_'+i)
          .append($('<i>').append('-&gt; ' + translate('Drag&drop food here')));
      }
    }
    
    function addHiddenCount(hiddentotal) {
      $('#fe_quickpick_hiddencount').text(hiddentotal ? (' ('+hiddentotal+')') : '');
    }
    
    var hiddentotal = 0;
    $('#fe_picklist').empty();
    for (var i=0; i<foodquickpick.length; i++) {
      var q = foodquickpick[i];
      if (showhidden === false && q.hidden) { hiddentotal++; continue; }
      $('#fe_picklist')
        .append($('<fieldset>').attr('id','fe_qpfieldset_'+i).addClass('sortablequickpick').attr('index',i).attr('_id',q._id)
          .append($('<legend>')
            .append($('<img>').attr('title',translate('Move to the top')).attr('src',icon_up).attr('index',i).addClass('fe_qpupimg'))
            .append(' | ')
            .append($('<img>').attr('title',translate('Delete record')).attr('src',icon_remove).attr('index',i).addClass('fe_qpremoveimg'))
            .append(' | ' + translate('Name') + ': ')
            .append($('<input type="text">').addClass('fe_qpname').attr('index',i).attr('value',q.name))
            .append($('<input type="checkbox">').addClass('fq_hidden').attr('index',i).prop('checked',q.hidden))
            .append(translate('Hidden'))
            .append($('<input type="checkbox">').addClass('fq_hideafteruse').attr('index',i).prop('checked',q.hideafteruse))
            .append(translate('Hide after use'))
            .append(' | ' + translate('Carbs') + ': ' + q.carbs.toFixed(0) + ' g')
          )
        );
        
      addHeaderOrHint(q,i);
      
      for (var j=0;j<q.foods.length; j++) {
        var r = q.foods[j];
        $('#fe_qpfieldset_'+i)
          .append($('<div>').attr('id','fqp_food_'+i+'_'+j).addClass('fe_foodinsideqp')
            .append($('<span>').addClass('width50px')
              .append($('<img>').attr('title',translate('Delete record')).attr('src',icon_remove).attr('index',i).attr('findex',j).addClass('fe_qpfoodremoveimg'))
            )
            .append($('<span>').addClass('width200px').append(r.name))
            .append($('<span>').addClass('width150px').css('text-align','center').append(r.portion))
            .append($('<span>').addClass('width100px').css('text-align','center').append(r.carbs))
            .append(translate('Portions')+': ')
            .append($('<input type="text">').attr('id','fq_portions_'+q._id+'_'+j).attr('index',i).attr('findex',j).attr('value',r.portions).addClass('fe_qpportions'))
          );
      }
    }
    
    $('.fe_qpupimg').click(quickpickMoveToTop);
    $('.fe_qpremoveimg').click(deleteQuickpickRecord);
    $('.fe_qpfoodremoveimg').click(deleteQuickpickFood);
    $('.fe_qpportions').change(savePortions);

    addHiddenCount(hiddentotal);
    
    $('.fe_qpname').change(function nameChange(event) {
      var index = $(this).attr('index');
      foodquickpick[index].name = $(this).val();
      event.preventDefault();
    });
    $('.fq_hidden').change(function hiddenChange(event) {
      var index = $(this).attr('index');
      foodquickpick[index].hidden = this.checked;
      if (!this.checked) {
        foodquickpick.splice(0, 0, foodquickpick.splice(index, 1)[0]);
      }
      drawQuickpick();
      event.preventDefault();
    });
    
    $('.fq_hideafteruse').change(function hideAfterUseChange(event) {
      var index = $(this).attr('index');
      foodquickpick[index].hideafteruse = this.checked;
      event.preventDefault();
    });
    
    $('.sortablequickpick').droppable({
      hoverClass: 'ui-state-hover',
      drop: dropFood,
      scope: 'foodlist',
      greedy: true
    });
    $('#fe_picklist').sortable({
        revert: true
      , axis: 'y'
      , placeholder: 'highlight'
      , update: resortArray
    });
  }
  
  function savePortions(event) {
    var index = $(this).attr('index');
    var findex = $(this).attr('findex');
    var val = parseFloat($(this).val().replace(/\,/g,'.'));
    foodquickpick[index].foods[findex].portions=val;
    calculateCarbs(index);
    drawQuickpick();
    event.preventDefault();
    return false;
  }
  
  function deleteQuickpickFood(event) {
    var index = $(this).attr('index');
    var findex = $(this).attr('findex');
    foodquickpick[index].foods.splice(findex,1);
    calculateCarbs(index);
    drawQuickpick();
    event.preventDefault();
    return false;
  }
  
  function dropFood(event,ui) {

    var item = ui.draggable;
    var fi = foodlist[item.attr('index')];
    
    var qi = $(this).attr('index');
    var q = foodquickpick[qi];
    
    fi.portions = 1;
    q.foods.push(fi);
    calculateCarbs(qi);
    
    drawQuickpick();
  }

  function calculateCarbs(index) {
    var qp = foodquickpick[index];
    qp.carbs = 0;
    if (qp.foods) {
      for (var j=0;j<qp.foods.length; j++) {
        qp.carbs += qp.foods[j].carbs * qp.foods[j].portions;
      }
    } else {
      qp.foods = [];
    }
  }
  
  function resortArray(event,ui) {
    var newHtmlIndex = ui.item.index();
    var oldArrayIndex = ui.item.attr('index');
    var draggeditem = foodquickpick.splice(oldArrayIndex, 1)[0];
    foodquickpick.splice(newHtmlIndex, 0, draggeditem);
    event.stopPropagation();
    drawQuickpick();
    console.log(foodquickpick);
    return;
  }
  
  function quickpickMoveToTop(event) {
    var index = $(this).attr('index');
    foodquickpick.splice(0, 0, foodquickpick.splice(index, 1)[0]);
    drawQuickpick();
    maybePreventDefault(event);
    return false;
  }
  
  // fill GUI with values from object
  function objectToGUI() {
    $('#fe_filter_category').val(filter.category);
    $('#fe_filter_subcategory').val(filter.subcategory);
    $('#fe_filter_name').val(filter.name);
    
    $('#fe_id').val(foodrec._id);
    $('#fe_category').val(foodrec.category);
    $('#fe_subcategory').val(foodrec.subcategory);
    $('#fe_name').val(foodrec.name);
    $('#fe_portion').val(foodrec.portion ? foodrec.portion : '');
    $('#fe_unit').val(foodrec.unit);
    $('#fe_carbs').val(foodrec.carbs ? foodrec.carbs : '');
    $('#fe_gi').val(foodrec.gi);
    
    $('#fe_quickpick_showhidden').prop('checked',showhidden);

    console.info(JSON.stringify(foodrec));
  }
  
  function GUIToObject() {
    // Grab values from html GUI to object
    filter.category = $('#fe_filter_category').val();
    filter.subcategory = $('#fe_filter_subcategory').val();
    filter.name = $('#fe_filter_name').val();
    
    foodrec._id = $('#fe_id').val();
    foodrec.category = $('#fe_category').val();
    foodrec.subcategory = $('#fe_subcategory').val();
    foodrec.name = $('#fe_name').val();
    foodrec.portion = parseInt($('#fe_portion').val());
    foodrec.portion = foodrec.portion || 0;
    foodrec.unit = $('#fe_unit').val();
    foodrec.carbs = parseInt($('#fe_carbs').val());
    foodrec.carbs = foodrec.carbs || 0;
    foodrec.gi = parseInt($('#fe_gi').val());
    
    showhidden = $('#fe_quickpick_showhidden').is(':checked');
  }
  
  function clearRec(event) {
    foodrec = _.cloneDeep(foodrec_template);
    objectToGUI();
    updateSaveButton();
    maybePreventDefault(event);
    return false;
  }
  
  function foodSubmit(event) {
    GUIToObject();

    if (!client.hashauth.isAuthenticated()) {
      alert(translate('Your device is not authenticated yet'));
      maybePreventDefault(event);
      return false;
    }
     
    if ($('#fe_editcreate').text().indexOf(translate('Create new record'))>-1) {
      
      // remove _id when creating new record
      delete foodrec._id;
      
      $.ajax({
        method: 'POST',
        url: '/api/v1/food/',
        data: foodrec,
        headers: client.headers()
      }).done(function success (response) {
        $('#fe_status').hide().text('OK').fadeIn('slow');
        foodrec._id = response[0]._id;
        foodlist.push(foodrec);
        if (foodrec.category && !categories[foodrec.category]) {
          categories[foodrec.category] = {};
        }
        if (foodrec.category && foodrec.subcategory) {
          categories[foodrec.category][foodrec.subcategory] = true;
        }
        clearRec();
        fillForm();
       }).fail(function fail() {
        $('#fe_status').hide().text(translate('Error')).fadeIn('slow');
      });
    } else {
      // Update record
      $.ajax({
        method: 'PUT',
        url: '/api/v1/food/',
        data: foodrec,
        headers: client.headers()
      }).done(function success () {
        $('#fe_status').hide().text('OK').fadeIn('slow');
        updateFoodArray(foodrec);
        clearRec();
        fillForm();
       }).fail(function fail() {
        $('#fe_status').hide().text(translate('Error')).fadeIn('slow');
      });
    }
    maybePreventDefault(event);
    return false;
  }

  function deleteRecord(_id) {
    if (!client.hashauth.isAuthenticated()) {
      alert(translate('Your device is not authenticated yet'));
      maybePreventDefault(event);
      return false;
    }

    $.ajax({
      method: 'DELETE',
      url: '/api/v1/food/'+_id,
      data: foodrec,
      headers: client.headers()
    }).done(function success () {
      $('#fe_status').hide().text('OK').fadeIn('slow');
     }).fail(function fail() {
      $('#fe_status').hide().text(translate('Error')).fadeIn('slow');
    });

    return false;
  }

  function updateRecord(foodrec) {
    if (!client.hashauth.isAuthenticated()) {
      alert(translate('Your device is not authenticated yet'));
      maybePreventDefault(event);
      return false;
    }
      
    $.ajax({
      method: 'PUT',
      url: '/api/v1/food/',
      data: foodrec,
      headers: client.headers()
    }).done(function success (response) {
      console.log('Updated record: ',response);
    });
  }

  function quickpickCreateRecord(event) {
    var newrec = _.cloneDeep(quickpickrec_template);
    
    if (!client.hashauth.isAuthenticated()) {
      alert(translate('Your device is not authenticated yet'));
      maybePreventDefault(event);
      return false;
    }
      
    // remove _id when creating new record
    delete newrec._id;
    
    $.ajax({
      method: 'POST',
      url: '/api/v1/food/',
      data: newrec,
      headers: client.headers()
    }).done(function success (response) {
      $('#fe_status').hide().text('OK').fadeIn('slow');
      newrec._id = response[0]._id;
      foodquickpick.unshift(newrec);
      drawQuickpick();
    }).fail(function fail() {
      $('#fe_status').hide().text(translate('Error')).fadeIn('slow');
    });

    maybePreventDefault(event);
    return false;
  }

  function quickpickSave(event) {
    if (!client.hashauth.isAuthenticated()) {
      alert(translate('Your device is not authenticated yet'));
      return false;
    }
      
    for (var i=0; i<foodquickpicktodelete.length; i++) {
      deleteRecord(foodquickpicktodelete[i]);
    }
    
    for (i=0; i<foodquickpick.length; i++) {
      var fqp = foodquickpick[i];
      if (fqp.hidden) {
        fqp.position = HIDDEN;
      } else {
        fqp.position = i;
      }
      updateRecord(fqp);
    }
    maybePreventDefault(event);
    return false;
  }
  
  function cmp(v1,v2){
    return (v1<v2?-1:(v1>v2?1:0));
  }

  function maybePreventDefault(event,after) {
    if (event) {
      event.preventDefault();
    }
    if (after) {
      after();
    }
  }
});
})();