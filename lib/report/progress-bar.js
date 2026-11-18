'use strict';

// Progress bar shown in the report's #info area while the day data loads.
// It uses the jQuery UI progressbar widget when that is loaded and a plain
// element otherwise (styled by #report-progressbar in report.css).
const ID = 'report-progressbar';

function hasWidget (bar) {
  return typeof bar.progressbar === 'function';
}

function create (container) {
  const bar = $('<div id="' + ID + '"></div>');
  $(container).append(bar);
  if (hasWidget(bar)) {
    bar.progressbar({value: 0});
  } else {
    bar.attr({
        role: 'progressbar'
        , 'aria-valuemin': 0
        , 'aria-valuemax': 100
        , 'aria-valuenow': 0
      })
      .append($('<div>').addClass('report-progress-value'));
  }
  return bar;
}

// value is a percentage from 0 to 100
function update (value) {
  const bar = $('#' + ID);
  if (hasWidget(bar)) {
    bar.progressbar({value: value});
  } else {
    bar.attr('aria-valuenow', value);
    bar.find('.report-progress-value').css('width', value + '%');
  }
}

module.exports = {create: create, update: update};
