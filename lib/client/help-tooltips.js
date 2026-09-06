'use strict';

const installed = new WeakMap();

// One delegated, text-only tooltip per document. Chart/pill tooltips are separate.
module.exports = function installHelpTooltips(doc, {touch = false} = {}) {
  if (installed.has(doc)) return installed.get(doc);
  const win = doc.defaultView;
  const tip = doc.createElement('div');
  tip.className = 'ns-help-tooltip';
  tip.id = 'ns-help-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  doc.body.appendChild(tip);
  let owner = null, previousDescription = null, touching = false;
  const text = element => (element.getAttribute('original-title') || element.getAttribute('title') || '').trim();
  const target = node => node && node.closest ? node.closest('.tip') : null;
  const isHelp = element => element && element.closest('#drawer') && element.matches('a:not([href])');

  function hide() {
    if (owner) {
      if (previousDescription === null) owner.removeAttribute('aria-describedby');
      else owner.setAttribute('aria-describedby', previousDescription);
    }
    owner = null;
    previousDescription = null;
    tip.hidden = true;
  }
  function position() {
    if (!owner || !owner.isConnected) return hide();
    const box = owner.getBoundingClientRect();
    // Measure at an unconstrained horizontal position before placing new text.
    tip.style.left = '0px';
    tip.style.top = '0px';
    const bounds = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(box.left + (box.width - bounds.width) / 2, win.innerWidth - bounds.width - 8));
    const below = box.bottom + 6;
    const top = below + bounds.height <= win.innerHeight - 8 ? below : Math.max(8, box.top - bounds.height - 6);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function show(element) {
    const value = text(element);
    if (!value) return hide();
    if (owner !== element) {
      hide();
      owner = element;
      previousDescription = element.getAttribute('aria-describedby');
    }
    // Suppress competing native title popups; translation still uses original-title.
    element.setAttribute('original-title', value);
    element.removeAttribute('title');
    if (isHelp(element)) element.setAttribute('aria-label', value);
    // Help buttons already expose this text in their accessible name. Keep
    // unrelated descriptions, but do not expose the same text a second time.
    const description = [previousDescription, element.getAttribute('aria-label') === value ? null : tip.id].filter(Boolean).join(' ');
    if (description) element.setAttribute('aria-describedby', description);
    else element.removeAttribute('aria-describedby');
    tip.textContent = value;
    tip.hidden = false;
    position();
  }
  for (const element of doc.querySelectorAll('#drawer .tip')) {
    if (isHelp(element)) {
      if (!element.hasAttribute('tabindex')) element.tabIndex = 0;
      if (!element.hasAttribute('role')) element.setAttribute('role', 'button');
      if (!element.hasAttribute('aria-label')) element.setAttribute('aria-label', text(element));
    }
  }
  function over(event) {
    if (event.pointerType === 'touch') return;
    const element = target(event.target);
    if (element && (!touch || element.closest('#drawer'))) show(element);
  }
  function out(event) {
    if (!owner || event.pointerType === 'touch') return;
    if (owner.contains(event.relatedTarget) || tip.contains(event.relatedTarget)) return;
    if (owner.contains(doc.activeElement)) return;
    hide();
  }
  function focus(event) {const element = target(event.target); if (element && !touching) show(element);}
  function blur(event) {if (owner && owner.contains(event.target) && !owner.contains(event.relatedTarget)) hide();}
  function click(event) {
    const element = target(event.target);
    if (touch && isHelp(element)) {
      event.preventDefault();
      if (owner === element && !tip.hidden) hide(); else show(element);
    } else if (!element) hide();
  }
  function down(event) {touching = event.pointerType === 'touch';}
  function key(event) {
    touching = false;
    if (event.key === 'Escape') hide();
    else if (['Enter', ' '].includes(event.key) && isHelp(target(event.target))) {
      event.preventDefault();
      show(target(event.target));
    }
  }
  function scroll() {
    // Native keyboard focus may scroll its trigger into view after focusin.
    // Keep focused help attached; scrolling still dismisses hover-only help.
    if (owner && owner.contains(doc.activeElement)) position(); else hide();
  }
  const listeners = [['pointerdown', down], ['pointerover', over], ['pointerout', out], ['focusin', focus], ['focusout', blur], ['click', click], ['keydown', key]];
  for (const [name, handler] of listeners) doc.addEventListener(name, handler);
  // WebKit touch synthesis needs a click listener on this non-interactive
  // element; document delegation alone may not produce a tooltip tap click.
  tip.addEventListener('click', hide);
  win.addEventListener('resize', hide);
  doc.addEventListener('scroll', scroll, true);
  const api = {destroy() {
    hide();
    for (const [name, handler] of listeners) doc.removeEventListener(name, handler);
    win.removeEventListener('resize', hide);
    doc.removeEventListener('scroll', scroll, true);
    tip.removeEventListener('click', hide);
    tip.remove();
    installed.delete(doc);
  }};
  installed.set(doc, api);
  return api;
};
