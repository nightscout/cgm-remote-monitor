'use strict';

// Native connectors have their own page and lifecycle, separate from admin tools.
// Add future in-tree sources here; each supplies a mount(client, container) method.
const sources = [
  { id: 'carelink', label: 'Medtronic CareLink', create: require('./carelink') }
];
const mounted = new WeakMap();

exports.mount = function mount(client, container) {
  const list = $(container);
  if (!list.length) throw new Error('Data sources container is missing');
  // Nightscout's initialization callback can run again after socket reconnects.
  if (mounted.has(list[0])) return mounted.get(list[0]);
  list.empty();
  const controllers = sources.map(source => {
    const card = $('<section>').attr({ id: source.id, 'aria-label': source.label }).appendTo(list);
    const content = $('<div>').appendTo(card);
    const controller = source.create();
    controller.mount(client, content);
    return controller;
  });
  mounted.set(list[0], controllers);
  return controllers;
};
