'use strict';

const messages = {
  worker_unavailable: 'The secure browser could not start. Use the CareLink-enabled container and its supplied security profile.',
  insufficient_memory: 'There is not enough free memory to open the login screen. Allow at least 512 MiB of additional memory and try again.',
  unauthorized: 'Sign in to Nightscout with permission to manage data sources.',
  provider_unavailable: 'Nightscout could not complete a request to CareLink. Please try again.',
  provider_configuration: 'CareLink changed its sign-in configuration. This connector needs an update.',
  login_in_progress: 'A login is already in progress. Resume it below, or wait for it to finish.',
  connection_busy: 'Another connection operation is finishing. Please try again shortly.',
  source_conflict: 'Confirm that you want to replace the existing data source before continuing.',
  reconnect_required: 'CareLink needs you to sign in again. Historical Nightscout data is unchanged.',
  encryption_key_changed: 'The saved connection cannot be unlocked, usually because API_SECRET changed. Sign in to CareLink again.',
  no_patients: 'CareLink did not return any eligible accounts. Check your CareLink sharing settings.',
  patient_unavailable: 'The selected patient is no longer available. Reconnect and choose an eligible account.',
  invalid_callback: 'The sign-in response could not be verified. Please start a new login.',
  login_rejected: 'CareLink did not authorize this connection. You can try again.',
  storage_unavailable: 'Nightscout could not save the connection or imported data. Check the database and try again.'
};

module.exports = function connect() {
  let client, root, country, status, details, connectButton, disconnectButton, replace, panel, image,
    relay, focusLabel, patientBox, session, timer, streaming = false, seq = 0, running = true,
    pendingInput = Promise.resolve(), pendingCount = 0, pageWindow, feedback, feedbackTitle, feedbackText,
    feedbackDiagnostic, retryButton, cancelButton;
  const plugin = { name: 'connect', label: 'Data sources — Medtronic CareLink', pluginType: 'admin' };
  function api(method, path, body, timeout = 25000) {
    return Promise.resolve($.ajax({ method, url: '/api/v1/connect/carelink' + path, headers: client.headers(),
      contentType: 'application/json', data: body === undefined ? undefined : JSON.stringify(body), timeout,
      cache: false }));
  }
  function error(err) {
    const code = err?.responseJSON?.error;
    status.text(messages[code] || 'The connection could not be completed. Please try again.');
  }
  function button(text, fn) {
    return $('<button type="button">').text(text).on('click', fn);
  }
  function send(input) {
    if (!session || session.state !== 'waiting' || pendingCount >= 32) return;
    const id = session.id;
    pendingCount++;
    pendingInput = pendingInput.then(() => {
      if (session?.id !== id || session.state !== 'waiting') return;
      return api('POST', '/sessions/' + id + '/input', input).then(result => {
        if (result.focus) focusLabel.text(result.focus.label || result.focus.type || 'CareLink page');
      });
    }).catch(error).finally(() => { pendingCount--; });
  }
  function keyboard(event) {
    if (event.originalEvent?.isComposing) return;
    if (['Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); send({ type: 'key', key: event.key });
    }
  }
  function inserted(event) {
    if (event.originalEvent?.isComposing) return;
    const text = relay.val(); relay.val('');
    if (text) send({ type: 'text', text });
  }
  function renderSession(value) {
    const previous = session;
    session = value;
    const active = value && ['starting', 'waiting', 'exchanging', 'selecting', 'saving'].includes(value.state);
    // Keep a result card in the exact place occupied by the login display.
    // A failed token exchange must never collapse the user's whole login area.
    panel.toggle(!!value);
    if (active) connectButton.prop('disabled', true);
    country.prop('disabled', !!active);
    if (!value) {
      image.removeAttr('src'); relay.val(''); patientBox.empty();
      return;
    }
    const words = { starting: 'Opening the secure CareLink login…', waiting: 'Sign in to CareLink below. Complete any verification on the page.',
      exchanging: value.phase === 'account_lookup' ? 'CareLink authorized the connection. Loading the accounts you can use…' :
        'CareLink returned the sign-in response. Completing the secure connection…',
      selecting: 'Choose whose data Nightscout should display.', saving: 'Saving your connection…',
      expired: 'The login timed out. Start again when you are ready.', cancelled: 'Sign-in cancelled. Your saved connection has not changed.',
      failed: messages[value.error] || 'Sign-in failed. Please try again.' };
    const titles = { starting: 'Opening CareLink', waiting: 'Sign in to CareLink', exchanging: 'Finishing your connection',
      selecting: 'Confirm your account', saving: 'Saving your connection', failed: 'CareLink connection not completed',
      expired: 'Sign-in timed out', cancelled: 'Sign-in cancelled', connected: 'CareLink connected' };
    if (value.state !== 'connected') status.text(words[value.state]);
    feedback.attr('data-state', value.state).attr('aria-busy', value.state === 'exchanging' || value.state === 'saving' ? 'true' : 'false');
    feedbackTitle.text(titles[value.state] || 'CareLink connection');
    feedbackText.text(value.state === 'connected' ? status.text() : words[value.state]);
    const operations = { discovery: 'Login discovery', login_configuration: 'Login configuration', token_exchange: 'Token exchange',
      token_refresh: 'Token refresh', account_lookup: 'Account lookup', account_details: 'Account details', account_profile: 'Account profile',
      country_settings: 'Country settings', patient_list: 'Shared accounts', glucose_data: 'Readings' };
    const reasons = { http_error: 'request rejected', invalid_json: 'unexpected response format', network_error: 'network failure',
      dns_error: 'address lookup failed', timeout: 'request timed out', response_too_large: 'response too large' };
    const d = value.diagnostic || {};
    const diagnostic = [operations[d.operation] || operations[value.phase],
      Number.isInteger(d.httpStatus) && d.httpStatus >= 100 && d.httpStatus <= 599 ? 'HTTP ' + d.httpStatus : null,
      reasons[d.reason]].filter(Boolean).join(' · ');
    feedbackDiagnostic.text(value.state === 'failed' && diagnostic ? 'Failed step: ' + diagnostic : '');
    retryButton.toggle(['failed', 'expired', 'cancelled'].includes(value.state)).prop('disabled', connectButton.prop('disabled'));
    cancelButton.toggle(!!active).prop('disabled', value.state === 'saving');
    root.find('.carelink-screen, .carelink-input-controls').toggle(value.state === 'waiting');
    relay.toggle(value.state === 'waiting');
    if (value.state === 'waiting' && !streaming) { seq = 0; void stream(value.id); }
    if (value.state !== 'waiting') { image.removeAttr('src'); relay.val(''); }
    if (value.state !== 'selecting') patientBox.empty();
    if (value.state === 'selecting' && !patientBox.children().length) {
      const select = $('<select aria-label="CareLink account">');
      value.patients.forEach(p => select.append($('<option>').val(p.username).text(p.label + (p.label !== p.username ? ' (' + p.username + ')' : ''))));
      patientBox.append($('<p>').text('Confirm this account before starting the import.')).append(select)
        .append(button('Use this account', function () {
          $(this).prop('disabled', true);
          api('POST', '/sessions/' + value.id + '/patient', { patient: select.val() }).then(() => refresh()).catch(err => {
            $(this).prop('disabled', false); error(err);
          });
        }));
    }
    if (previous?.id === value.id && previous.state !== value.state && !['starting', 'waiting'].includes(value.state)) {
      feedback[0].focus({ preventScroll: true });
      feedback[0].scrollIntoView?.({ block: 'nearest' });
    }
  }
  async function stream(id) {
    streaming = true;
    try {
      while (running && session?.id === id && session.state === 'waiting') {
        const frame = await api('GET', '/sessions/' + id + '/frame?after=' + seq);
        if (session?.id !== id || session.state !== 'waiting') break;
        seq = frame.seq;
        if (frame.image) image.attr('src', 'data:image/jpeg;base64,' + frame.image);
        if (frame.state !== 'waiting') { await refresh(); break; }
        // A page generating frames continuously must still respect backpressure.
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    } catch (err) { if (running) error(err); }
    finally { streaming = false; }
  }
  async function refresh() {
    pageWindow.clearTimeout(timer);
    if (!running || !root[0].isConnected) return;
    try {
      const state = await api('GET', '');
      if (state.country && !session) country.val(state.country);
      let text = state.configured ? (state.connected ? 'Connected to CareLink.' : 'CareLink needs attention.') : 'CareLink is not connected.';
      if (state.connected) text += state.lastReading ? ' Latest reading: ' + new Date(state.lastReading).toLocaleString() + '.' : ' Waiting for CareLink readings.';
      if (state.error) text += ' ' + (messages[state.error] || 'The last sync could not finish; Nightscout will retry.');
      status.text(text);
      details.text(state.patient ? 'Account: ' + state.patient + (state.lastSync ? ' · Last successful check: ' + new Date(state.lastSync).toLocaleString() : '') : '');
      connectButton.text(state.configured ? 'Reconnect Medtronic' : 'Connect Medtronic');
      disconnectButton.toggle(state.configured);
      const conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
      replace.parent().toggle(conflicts.length > 0);
      replace.parent().find('span').text('Replace the existing source (' + conflicts.join(', ') + ') after CareLink connects');
      if (!state.available) status.text(messages.worker_unavailable);
      connectButton.prop('disabled', !state.available || state.busy);
      renderSession(state.session?.state === 'connected' && !state.configured ? null : state.session);
    } catch (err) { error(err); }
    if (running) timer = pageWindow.setTimeout(refresh, session && !['failed', 'expired', 'cancelled', 'connected'].includes(session.state) ? 1500 : 15000);
  }
  function init(c) {
    client = c;
    pageWindow = window;
    root = $('#admin_connect_0_html').addClass('carelink-native');
    root.closest('fieldset').attr('id', 'carelink');
    root.append($('<p>').text('Sign in on the genuine Medtronic page, displayed securely through your Nightscout server. Nightscout does not save your password.'));
    status = $('<p role="status" aria-live="polite">').text('Loading connection…').appendTo(root);
    details = $('<p class="carelink-details">').appendTo(root);
    country = $('<select id="carelink-country" aria-label="Country where your CareLink account is registered">');
    country.append($('<option value="">').text('Choose your CareLink account country'));
    root.append($('<label for="carelink-country">').text('Where is your CareLink account registered?')).append(country);
    replace = $('<input type="checkbox">');
    root.append($('<label class="carelink-replace">').append(replace).append($('<span>')).hide());
    connectButton = button('Connect Medtronic', async function () {
      connectButton.prop('disabled', true);
      try {
        const width = Math.min(1000, Math.max(320, root.width()));
        const height = Math.min(900, Math.max(520, window.innerHeight - 180));
        renderSession(await api('POST', '/sessions', { country: country.val(), width, height, replace: replace.prop('checked') }));
        await refresh();
      } catch (err) { error(err); connectButton.prop('disabled', false); }
    });
    disconnectButton = button('Disconnect', async () => {
      if (!window.confirm('Stop CareLink imports and remove its saved login? Your historical Nightscout data will be kept.')) return;
      try { await api('DELETE', ''); await refresh(); } catch (err) { error(err); }
    }).hide();
    root.append($('<div>').append(connectButton).append(disconnectButton));
    panel = $('<div class="carelink-panel">').hide().appendTo(root);
    feedback = $('<div class="carelink-feedback" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">').appendTo(panel);
    feedbackTitle = $('<h3>').appendTo(feedback);
    feedbackText = $('<p>').appendTo(feedback);
    feedbackDiagnostic = $('<p class="carelink-diagnostic">').appendTo(feedback);
    retryButton = button('Try signing in again', () => { if (!connectButton.prop('disabled')) connectButton.trigger('click'); }).hide().appendTo(feedback);
    image = $('<img class="carelink-screen" alt="Live Medtronic sign-in page. Tap a field to type, or use the keyboard controls below." draggable="false">').appendTo(panel);
    relay = $('<input class="carelink-keyboard" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Keyboard input for the selected CareLink field">')
      .on('keydown', keyboard).on('input compositionend', inserted).appendTo(panel);
    let pointer, dragging = false, lastMove = 0;
    function point(event) {
      const rect = image[0].getBoundingClientRect();
      return { x: Math.min(session.width - 1, Math.max(0, (event.clientX - rect.left) * session.width / rect.width)),
        y: Math.min(session.height - 1, Math.max(0, (event.clientY - rect.top) * session.height / rect.height)) };
    }
    image.on('pointerdown', event => {
      event.preventDefault(); pointer = point(event); dragging = event.pointerType !== 'touch';
      image[0].setPointerCapture(event.pointerId);
      if (dragging) send({ type: 'pointer', phase: 'down', ...pointer });
    });
    image.on('pointermove', event => {
      if (!pointer || Date.now() - lastMove < 100) return;
      const current = point(event);
      // A touch swipe scrolls; a horizontal gesture can operate a slider.
      if (!dragging && Math.abs(current.x - pointer.x) > 12 && Math.abs(current.x - pointer.x) > Math.abs(current.y - pointer.y)) {
        dragging = true; send({ type: 'pointer', phase: 'down', ...pointer });
      }
      if (dragging) { lastMove = Date.now(); send({ type: 'pointer', phase: 'move', ...current }); }
    });
    image.on('pointerup', event => {
      if (!pointer) return;
      const end = point(event);
      if (dragging) send({ type: 'pointer', phase: 'up', ...end });
      else if (Math.abs(end.y - pointer.y) > 12) send({ type: 'scroll', ...pointer, delta: pointer.y - end.y });
      else send({ type: 'click', ...end });
      if (Math.abs(end.x - pointer.x) < 12 && Math.abs(end.y - pointer.y) < 12) relay.trigger('focus');
      pointer = null; dragging = false;
    });
    image.on('pointercancel', () => {
      if (pointer && dragging) send({ type: 'pointer', phase: 'up', ...pointer });
      pointer = null; dragging = false;
    });
    image.on('wheel', event => { event.preventDefault(); send({ type: 'scroll', ...point(event.originalEvent), delta: event.originalEvent.deltaY }); });
    const controls = $('<div class="carelink-input-controls">').appendTo(panel);
    controls.append(button('Previous field', () => send({ type: 'key', key: 'Tab', shift: true })))
      .append(button('Next field', () => send({ type: 'key', key: 'Tab' })))
      .append(button('Keyboard', () => relay.toggleClass('carelink-keyboard-visible').trigger('focus')))
      .append(button('Enter', () => send({ type: 'key', key: 'Enter' })));
    focusLabel = $('<p class="carelink-focus" aria-live="polite">').appendTo(controls);
    patientBox = $('<div class="carelink-patients">').appendTo(panel);
    cancelButton = button('Cancel sign-in', async () => {
      try { await api('DELETE', '/sessions/' + session.id); await refresh(); } catch (err) { error(err); }
    }).appendTo(panel);
    api('GET', '/countries').then(countries => {
      if (!Array.isArray(countries)) throw new Error('Invalid countries');
      countries.forEach(c => country.append($('<option>').val(c.code).text(c.name)));
      return refresh();
    }).catch(error);
    window.addEventListener('pagehide', () => { running = false; pageWindow.clearTimeout(timer); relay.val(''); image.removeAttr('src'); });
    if (window.location.hash === '#carelink') root[0].scrollIntoView();
  }
  plugin.actions = [{ description: 'Connect or reconnect without copying tokens or editing server settings.',
    buttonLabel: 'Refresh connection status', preventClose: true, init, code: refresh }];
  return plugin;
};
