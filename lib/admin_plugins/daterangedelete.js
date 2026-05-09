'use strict';

var moment;

var daterangedelete = {
  name: 'daterangedelete',
  label: 'Delete MongoDB records by date range',
  pluginType: 'admin'
};

function init(ctx) {
  moment = ctx.moment;
  return daterangedelete;
}

module.exports = init;

daterangedelete.actions = [
  {
    name: 'Delete records from selected collections within a date range',
    description: 'This task removes documents from selected MongoDB collections for a specified date range. You can delete from a single collection or from all collections at once.',
    buttonLabel: 'Delete records in date range',
    preventClose: true
  }
];

daterangedelete.actions[0].init = function init(client, callback) {
  var translate = client.translate;
  var pName = daterangedelete.name;
  var $status = $('#admin_' + pName + '_0_status');
  var $previewBtn, $previewCount;

  // Build HTML for the plugin UI
  var html =
    '<br/>' +
    '<label for="admin_daterange_collection">' +
      translate('Collection:') +
      '  <select id="admin_daterange_collection">' +
        '    <option value="all">' + translate('All Collections (entries, treatments, devicestatus)') + '</option>' +
        '    <option value="entries">' + translate('Glucose Entries (entries)') + '</option>' +
        '    <option value="treatments">' + translate('Treatments') + '</option>' +
        '    <option value="devicestatus">' + translate('Device Status (devicestatus)') + '</option>' +
      '  </select>' +
    '</label>' +
    '<br/><br/>' +
    '<label for="admin_daterange_start">' +
      translate('Start Date (inclusive):') +
      '  <input type="date" id="admin_daterange_start" />' +
    '</label>' +
    '<br/><br/>' +
    '<label for="admin_daterange_end">' +
      translate('End Date (inclusive):') +
      '  <input type="date" id="admin_daterange_end" />' +
    '</label>' +
    '<br/><br/>' +
    '<div style="margin-top: 10px;">' +
      '<button id="admin_daterange_preview" class="daterangePreviewButton" style="display: inline-block; margin-right: 10px;">' + translate('Preview') + '</button>' +
      '<span id="admin_daterange_preview_count" style="font-weight: bold; margin-left: 10px;"></span>' +
    '</div>' +
    '<div id="admin_daterangedelete_info" style="font-style: italic; color: #666; margin-top: 5px;"></div>' +
    '<br/>';

  $('#admin_' + pName + '_0_html').html(html);

  $status.hide();
  $previewBtn = $('#admin_daterange_preview');
  $previewCount = $('#admin_daterange_preview_count');

  // Event handlers
  $('#admin_daterange_collection').on('change', function() {
    validateAndPreview(client);
  });

  $('#admin_daterange_start, #admin_daterange_end').on('change', function() {
    validateDates(client);
  });

  $previewBtn.on('click', function(e) {
    e.preventDefault();
    validateAndPreview(client);
  });

  function validateDates(client) {
    var translate = client.translate;
    var $info = $('#admin_daterangedelete_info');
    var startDate = $('#admin_daterange_start').val();
    var endDate = $('#admin_daterange_end').val();

    if (!startDate || endDate === '') {
      // endDate can be same as startDate, but both should be present for preview
    }

    if (!startDate || !endDate) {
      $info.text(translate('Please select both start and end dates'));
      return false;
    }

    var start = moment(startDate);
    var end = moment(endDate);

    if (!start.isValid() || !end.isValid()) {
      $info.text(translate('Please select valid dates'));
      return false;
    }

    if (start.isAfter(end)) {
      $info.text(translate('Start date must be before or equal to end date'));
      return false;
    }

    var now = moment();
    var oneYearAgo = now.clone().subtract(1, 'years');
    var oneYearFuture = now.clone().add(1, 'years');

    if (start.isBefore(oneYearAgo) || end.isAfter(oneYearFuture)) {
      $info.text(translate('Warning: Date range seems unusually large'));
    } else {
      $info.text('');
    }

    return true;
  }

  function validateAndPreview(client) {
    var translate = client.translate;
    var collection = $('#admin_daterange_collection').val();
    var startDateStr = $('#admin_daterange_start').val();
    var endDateStr = $('#admin_daterange_end').val();

    if (!collection || !startDateStr || !endDateStr) {
      $previewCount.text('');
      return;
    }

    // Validate dates first
    if (!validateDates(client)) {
      $previewCount.text('');
      return;
    }

    // Use profile timezone if available
    var zone = (client.sbx && client.sbx.data && client.sbx.data.profile) ? client.sbx.data.profile.getTimezone() : null;
    var startDate = zone ? moment.tz(startDateStr, zone) : moment(startDateStr);
    var endDate = zone ? moment.tz(endDateStr, zone) : moment(endDateStr);

    var collectionsToPreview = [];
    if (collection === 'all') {
      collectionsToPreview = ['entries', 'treatments', 'devicestatus'];
    } else {
      collectionsToPreview = [collection];
    }

    var queries = [];
    var totalCount = 0;
    var previewLimit = 10000;

    collectionsToPreview.forEach(function(col) {
      var queryParams = '';
      var dateField = '';

      if (col === 'entries') {
        dateField = 'date';
        var startTime = startDate.startOf('day').valueOf();
        var endTime = endDate.endOf('day').valueOf();
        queryParams = '?find[' + dateField + '][$gte]=' + startTime + '&find[' + dateField + '][$lte]=' + endTime + '&count=' + previewLimit;
      } else {
        dateField = 'created_at';
        var startISO = startDate.startOf('day').toISOString();
        var endISO = endDate.endOf('day').toISOString();
        queryParams = '?find[' + dateField + '][$gte]=' + encodeURIComponent(startISO) + '&find[' + dateField + '][$lte]=' + encodeURIComponent(endISO) + '&count=' + previewLimit;
      }

      // Use .json extension to ensure JSON response
      var countUrl = '/api/v1/' + col + '.json' + queryParams;
      queries.push({ collection: col, url: countUrl });
    });

    if (queries.length === 1) {
      $previewCount.html('<span style="color: #666;">' + translate('Checking...') + '</span>');
    } else {
      $previewCount.html('<span style="color: #666;">' + translate('Checking collections...') + '</span>');
    }

    var completed = 0;
    var results = {};

    queries.forEach(function(query) {
      $.ajax({
        url: query.url,
        method: 'GET',
        headers: client.headers(),
        cache: false,
        success: function(data) {
          var count = 0;
          if (Array.isArray(data)) {
            count = data.length;
          } else if (data && data.n !== undefined) {
            count = data.n;
          }
          results[query.collection] = count;
          if (count > 0) {
            totalCount += count;
          }
          completed++;
          updatePreview();
        },
        error: function() {
          results[query.collection] = -1;
          completed++;
          updatePreview();
        }
      });
    });

    function updatePreview() {
      if (completed < queries.length) {
        return;
      }

      var threshold = previewLimit;
      var summary = [];
      var hasPotentialMore = false;

      collectionsToPreview.forEach(function(col) {
        var count = results[col];
        var colText = '';
        if (count === -1) {
          colText = '<span style="color: red;">' + col + ': ERROR</span>';
        } else if (count >= threshold) {
          colText = '<span style="color: orange;">' + col + ': ≥ ' + count + '</span>';
          hasPotentialMore = true;
        } else if (count === 0) {
          colText = '<span style="color: gray;">' + col + ': 0</span>';
        } else {
          colText = '<span style="color: green; font-weight: bold;">' + col + ': ' + count + '</span>';
        }
        summary.push(colText);
      });

      var summaryLine = '';
      if (queries.length === 1) {
        var col = queries[0].collection;
        var count = results[col];
        if (count === -1) {
          summaryLine = '<span style="color: red;">' + translate('Error checking') + '</span>';
        } else if (count >= threshold) {
          summaryLine = '<span style="color: orange;">' + translate('At least %1 records match (limit reached)', {params: [count]}) + '</span>';
        } else if (count === 0) {
          summaryLine = '<span style="color: gray;">' + translate('No records found') + '</span>';
        } else {
          summaryLine = '<span style="color: green;">' + count + ' ' + translate('record(s) will be deleted') + '</span>';
        }
      } else {
        summaryLine = summary.join(' | ');
        if (hasPotentialMore) {
          summaryLine += ' | <span style="color: orange;">' + translate('some counts may be underestimated') + '</span>';
        }
        summaryLine += ' | <strong>' + translate('Total') + ': ' + totalCount + '</strong>';
      }

      $previewCount.html(summaryLine);
    }

    if (queries.length === 0) {
      validateDates(client);
    }
  }

  if (callback) { callback(); }
};

daterangedelete.actions[0].code = function deleteRecordsInDateRange(client, callback) {
  var translate = client.translate;
  var pName = daterangedelete.name;
  var $status = $('#admin_' + pName + '_0_status');
  var $info = $('#admin_daterangedelete_info');
  var $previewCount = $('#admin_daterange_preview_count');

  var collection = $('#admin_daterange_collection').val();
  var startDateStr = $('#admin_daterange_start').val();
  var endDateStr = $('#admin_daterange_end').val();

  // Check authentication
  if (!client.hashauth.isAuthenticated()) {
    alert(translate('Your device is not authenticated yet'));
    if (callback) { callback(); }
    return;
  }

  // Use profile timezone if available
  var zone = (client.sbx && client.sbx.data && client.sbx.data.profile) ? client.sbx.data.profile.getTimezone() : null;
  var startDate = zone ? moment.tz(startDateStr, zone) : moment(startDateStr);
  var endDate = zone ? moment.tz(endDateStr, zone) : moment(endDateStr);

  if (!startDate.isValid() || !endDate.isValid()) {
    alert(translate('Please select valid dates'));
    if (callback) { callback(); }
    return;
  }

  if (startDate.isAfter(endDate)) {
    alert(translate('Start date must be before or equal to end date'));
    if (callback) { callback(); }
    return;
  }

  // Determine which collections to delete from
  var collectionsToDelete = [];
  if (collection === 'all') {
    collectionsToDelete = ['entries', 'treatments', 'devicestatus'];
  } else {
    collectionsToDelete = [collection];
  }

  // Prepare confirmation message
  var confirmMsg;
  if (collection === 'all') {
    confirmMsg = translate('Are you sure you want to delete records from ALL collections (entries, treatments, devicestatus) for the date range') + '\n' +
                  startDateStr + ' → ' + endDateStr + '?\n\n' +
                  translate('This action cannot be undone.');
  } else {
    confirmMsg = translate('Are you sure you want to delete records from the selected collection for the date range') + '\n' +
                  startDateStr + ' → ' + endDateStr + '?';
  }

  if (!window.confirm(confirmMsg)) {
    if (callback) { callback(); }
    return;
  }

  // Show deleting status
  $status.hide().text(translate('Deleting records ...')).fadeIn('slow');
  $info.text('');
  $previewCount.text('');

  // Process each collection
  var totalDeleted = 0;
  var collectionsProcessed = 0;
  var collections = collectionsToDelete;
  var results = {};

  function deleteFromCollection(colIndex) {
    if (colIndex >= collections.length) {
      // All done
      $status.hide().text(translate('%1 records deleted total', { params: [totalDeleted] })).fadeIn('slow');
      if (callback) { callback(); }
      // Refresh preview after a delay
      setTimeout(function() {
        $('#admin_daterange_preview').click();
      }, 1000);
      return;
    }

    var col = collections[colIndex];
    var queryParams = '';
    var dateField = '';

    if (col === 'entries') {
      dateField = 'date';
      var startTime = startDate.startOf('day').valueOf();
      var endTime = endDate.endOf('day').valueOf();
      queryParams = '?find[' + dateField + '][$gte]=' + startTime + '&find[' + dateField + '][$lte]=' + endTime + '&count=100000';
    } else {
      dateField = 'created_at';
      var startISO = startDate.startOf('day').toISOString();
      var endISO = endDate.endOf('day').toISOString();
      queryParams = '?find[' + dateField + '][$gte]=' + encodeURIComponent(startISO) + '&find[' + dateField + '][$lte]=' + encodeURIComponent(endISO) + '&count=100000';
    }

    // URL pattern for expected test: /api/v1/col/ ?find...
    var url = '/api/v1/' + (col === 'entries' ? 'entries/*' : col) + '/' + queryParams;

    $.ajax({
      url: url,
      method: 'DELETE',
      headers: client.headers(),
      success: function(retVal) {
        var count = retVal.n || retVal.deletedCount || 0;
        results[col] = count;
        totalDeleted += count;
        collectionsProcessed++;
        // Update status with current progress
        $status.hide().text(translate('Deleted %1 from %2 (%3 of %4)', {
          params: [count, col, collectionsProcessed, collections.length]
        })).fadeIn('slow');
        // Continue to next collection immediately (no artificial delay)
        deleteFromCollection(colIndex + 1);
      },
      error: function(jqXHR, textStatus, errorThrown) {
        console.error('Delete error in ' + col + ':', textStatus, errorThrown);
        results[col] = 0;
        collectionsProcessed++;
        $info.text(translate('Error deleting from %1', { params: [col] }));
        // Continue to next collection anyway
        deleteFromCollection(colIndex + 1);
      }
    });
  }

  // Start deletion process
  deleteFromCollection(0);
};
