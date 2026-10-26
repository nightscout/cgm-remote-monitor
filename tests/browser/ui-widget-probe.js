'use strict';

// Executed inside the real page, including after HMR and cached navigation.
module.exports = function selectedWidgetsReady() {
  const $ = window.$;
  const methods = ['button', 'dialog', 'draggable', 'droppable', 'resizable', 'sortable'];
  if (!methods.every(name => typeof $.fn[name] === 'function')) return false;
  const button = $('<button>').text('Owned style probe').appendTo(document.body).button();
  try {
    const style = getComputedStyle(button[0]);
    return parseFloat(style.paddingLeft) > 0 && parseFloat(style.paddingTop) > 0;
  } finally {button.button('destroy').remove();}
};
