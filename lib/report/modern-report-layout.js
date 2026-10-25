'use strict';

// The normal report client owns data loading, filters and tab switching.
module.exports = function modernReportLayout ($) {
  var filters = $('#report-filters');
  if (filters.length && !filters.parent().hasClass('report-filter-panel')) {
    // Moving the original fields retains their values and existing handlers.
    var panel = $('<details class="report-filter-panel" open></details>');
    panel.append($('<summary></summary>').text(filters.children('legend').text()));
    filters.before(panel);
    panel.append(filters);
  }
  var navigation = $('#tabnav');
  function selected () {
    navigation.find('.menutab').each(function () {
      var tab = $(this);
      tab.attr({'role': 'button', 'tabindex': '0', 'aria-pressed': tab.hasClass('selected') ? 'true' : 'false'});
    });
  }
  // Existing report handlers return false and stop bubbling, so bind to the
  // same controls after those handlers rather than delegating to the list.
  navigation.find('.menutab').off('.modernReports')
    .on('click.modernReports', selected)
    .on('keydown.modernReports', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        $(this).trigger('click');
      }
    });
  selected();
};
