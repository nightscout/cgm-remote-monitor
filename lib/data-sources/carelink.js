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

module.exports = function carelink() {
  let client, root, country, status, details, connectButton, disconnectButton, replace, panel, image,
    relay, focusLabel, patientBox, session, timer, streaming = false, seq = 0, running = true,
    pendingInput = Promise.resolve(), pendingCount = 0, pageWindow, feedback, feedbackTitle, feedbackText,
    feedbackDiagnostic, retryButton, cancelButton, badge, setupPanel, settingsButton, overview, accountName,
    lastReading, lastSync, steps, browserFrame, browserLoading, technicalDetails, feedbackIcon, dismissButton,
    setupOpen = false, connectionState = {}, dismissedSession, requestError, countryEdited = false;
  function api(method, path, body, timeout = 25000) {
    return Promise.resolve($.ajax({ method, url: '/api/v1/connect/carelink' + path, headers: client.headers(),
      contentType: 'application/json', data: body === undefined ? undefined : JSON.stringify(body), timeout,
      cache: false }));
  }
  function error(err) {
    const code = err?.responseJSON?.error;
    const text = messages[code] || 'The connection could not be completed. Please try again.';
    setText(status, text);
    requestError.text(text).show();
  }
  function button(text, fn, variant = 'secondary') {
    return $('<button type="button">').addClass('carelink-button carelink-button-' + variant).text(text).on('click', fn);
  }
  function setText(element, text) {
    if (element.text() !== text) element.text(text);
  }
  function symbol(name) {
    const paths = {
      link: '<path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
      alert: '<path d="M12 8v5m0 4h.01"/><circle cx="12" cy="12" r="10"/>'
    };
    return $('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths[name] + '</svg>');
  }
  function relativeTime(value) {
    const date = new Date(value), minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
    if (!value || !Number.isFinite(date.getTime())) return 'Not yet';
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return minutes + ' min ago';
    if (minutes < 1440) return Math.floor(minutes / 60) + ' hr ago';
    return date.toLocaleDateString();
  }
  function updateSteps(value) {
    const state = value?.state;
    const failed = ['failed', 'expired'].includes(state);
    let current = connectionState.connected ? 3 : connectionState.configured ? 1 : 0;
    if (value && state !== 'cancelled' && state !== 'connected') current = ['selecting', 'saving'].includes(state) || value.phase === 'account_lookup' ? 2 : 1;
    steps.children().each(function (index) {
      const item = $(this), complete = index < current || (index === 3 && current === 3 && connectionState.connected && !failed);
      item.attr('data-state', complete ? 'complete' : index === current ? (failed ? 'error' : 'current') : 'upcoming');
      item.attr('aria-label', item.children().last().text() + (complete ? ', complete' : index === current && failed ? ', needs attention' : ''));
      if (index === current) item.attr('aria-current', 'step'); else item.removeAttr('aria-current');
      item.find('.carelink-step-number').text(complete ? '✓' : index + 1);
    });
  }
  function connectionBadge(text, tone) {
    badge.attr('data-tone', tone); setText(badge.find('span'), text);
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
    settingsButton.prop('disabled', !!active);
    setupPanel.toggle(!connectionState.configured || setupOpen || !!active);
    settingsButton.attr('aria-expanded', setupPanel.css('display') !== 'none' ? 'true' : 'false');
    updateSteps(value);
    steps.toggle(!connectionState.configured || !!active || value?.state === 'connected');
    if (!value) {
      image.removeAttr('src'); relay.val(''); patientBox.empty();
      return;
    }
    const words = { starting: 'Opening the secure CareLink login…', waiting: 'Sign in to CareLink below. Complete any verification on the page.',
      exchanging: value.phase === 'account_lookup' ? 'CareLink authorized the connection. Loading the accounts you can use…' :
        'CareLink returned the sign-in response. Completing the secure connection…',
      selecting: 'Choose whose data Nightscout should display.', saving: 'Saving your connection…',
      expired: 'The login timed out. Start again when you are ready.', cancelled: 'Sign-in cancelled. Your saved connection has not changed.',
      failed: (messages[value.error] || 'Sign-in failed. Please try again.') + (connectionState.connected ? ' Your existing connection is still active.' : '') };
    const titles = { starting: 'Opening CareLink', waiting: 'Sign in to CareLink', exchanging: 'Finishing your connection',
      selecting: 'Confirm your account', saving: 'Saving your connection', failed: 'CareLink connection not completed',
      expired: 'Sign-in timed out', cancelled: 'Sign-in cancelled', connected: 'CareLink connected' };
    if (value.state !== 'connected') setText(status, words[value.state]);
    feedback.attr('data-state', value.state).attr('aria-busy', value.state === 'exchanging' || value.state === 'saving' ? 'true' : 'false');
    setText(feedbackTitle, titles[value.state] || 'CareLink connection');
    setText(feedbackText, value.state === 'connected' ? status.text() : words[value.state]);
    const inProgress = ['starting', 'exchanging', 'saving'].includes(value.state);
    feedbackIcon.empty().toggleClass('carelink-spinner', inProgress);
    if (!inProgress) feedbackIcon.append(symbol(value.state === 'connected' ? 'check' : ['failed', 'expired'].includes(value.state) ? 'alert' : 'shield'));
    if (active) connectionBadge(value.state === 'waiting' ? 'Sign-in in progress' : 'Connecting', 'progress');
    else if (['failed', 'expired'].includes(value.state) && !connectionState.connected) connectionBadge('Not connected', 'warning');
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
    technicalDetails.toggle(value.state === 'failed' && !!diagnostic);
    if (previous?.state !== value.state) technicalDetails.prop('open', false);
    retryButton.toggle(['failed', 'expired', 'cancelled'].includes(value.state)).prop('disabled', connectButton.prop('disabled'));
    dismissButton.toggle(!active).text(value.state === 'connected' ? 'Back to connection overview' : 'Dismiss');
    feedback.find('.carelink-feedback-actions').toggle(!active);
    cancelButton.toggle(!!active).prop('disabled', value.state === 'saving');
    browserFrame.toggle(value.state === 'waiting');
    browserLoading.toggle(value.state === 'waiting' && !image.attr('src'));
    root.find('.carelink-screen, .carelink-input-controls').toggle(value.state === 'waiting');
    relay.toggle(value.state === 'waiting');
    if (value.state === 'waiting' && !streaming) { seq = 0; void stream(value.id); }
    if (value.state !== 'waiting') { image.removeAttr('src'); relay.val(''); }
    if (value.state !== 'selecting') patientBox.empty();
    if (value.state === 'selecting' && !patientBox.children().length) {
      const select = $('<select class="carelink-select" aria-label="CareLink account">');
      value.patients.forEach(p => select.append($('<option>').val(p.username).text(p.label + (p.label !== p.username ? ' (' + p.username + ')' : ''))));
      patientBox.append($('<label>').text('Account to connect').append(select))
        .append($('<p class="carelink-help">').text('Check the account carefully. Its readings will appear in this Nightscout.'))
        .append(button('Use this account', function () {
          $(this).prop('disabled', true);
          requestError.hide();
          api('POST', '/sessions/' + value.id + '/patient', { patient: select.val() }).then(() => refresh()).catch(err => {
            $(this).prop('disabled', false); error(err);
          });
        }, 'primary'));
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
        if (frame.image) { image.attr('src', 'data:image/jpeg;base64,' + frame.image); browserLoading.hide(); }
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
      connectionState = state;
      const completedOnLoad = state.session?.state === 'connected' && (!state.configured || !session);
      const visibleSession = completedOnLoad || state.session?.id === dismissedSession ? null : state.session;
      if (state.country && !session && !countryEdited) country.val(state.country);
      setText(setupPanel.children('h3'), state.configured ? 'Connection settings' : 'Connect your account');
      let text = state.configured ? (state.connected ? 'Connected to CareLink.' : 'CareLink needs attention.') : 'CareLink is not connected.';
      if (state.connected) text += state.lastReading ? ' Latest reading: ' + new Date(state.lastReading).toLocaleString() + '.' : ' Waiting for CareLink readings.';
      if (state.error) text += ' ' + (messages[state.error] || 'The last sync could not finish; Nightscout will retry.');
      if (!visibleSession || visibleSession.state === 'connected') setText(status, text);
      const stale = state.lastReading && Date.now() - state.lastReading > 15 * 60000;
      connectionBadge(state.error ? 'Needs attention' : state.connected ? (state.lastReading ? (stale ? 'Older readings' : 'Connected') : 'Waiting for data') : 'Not connected',
        state.error || stale ? 'warning' : state.connected && state.lastReading ? 'success' : 'neutral');
      overview.toggle(!!state.configured);
      accountName.text(state.patient || 'Awaiting confirmation');
      for (const [element, value] of [[lastReading, state.lastReading], [lastSync, state.lastSync]]) {
        element.text(relativeTime(value));
        if (value) element.attr('title', new Date(value).toLocaleString()); else element.removeAttr('title');
      }
      lastReading.attr('data-stale', stale ? 'true' : 'false');
      settingsButton.toggle(!!state.configured);
      connectButton.text(state.configured ? 'Reconnect Medtronic' : 'Connect Medtronic');
      disconnectButton.toggle(state.configured);
      const conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
      replace.parent().toggle(conflicts.length > 0);
      replace.parent().find('span').text('Replace the existing source (' + conflicts.join(', ') + ') after CareLink connects');
      if (!state.available && !state.configured) setText(status, messages.worker_unavailable);
      connectButton.prop('disabled', !state.available || state.busy);
      renderSession(visibleSession);
    } catch (err) { error(err); }
    if (running) timer = pageWindow.setTimeout(refresh, session && !['failed', 'expired', 'cancelled', 'connected'].includes(session.state) ? 1500 : 15000);
  }
  function mount(c, container) {
    client = c;
    pageWindow = window;
    root = $(container).addClass('carelink-native');
    const header = $('<div class="carelink-header">').appendTo(root);
    const identity = $('<div class="carelink-identity">').appendTo(header);
    $('<div class="carelink-provider-icon">').append(symbol('link')).appendTo(identity);
    const heading = $('<div>').appendTo(identity);
    $('<p class="carelink-eyebrow">').text('NIGHTSCOUT · DATA SOURCES').appendTo(heading);
    $('<h2>').text('Medtronic CareLink').appendTo(heading);
    badge = $('<div class="carelink-badge" data-tone="neutral">').append($('<i aria-hidden="true">')).append($('<span>').text('Loading')).appendTo(header);
    status = $('<p class="carelink-status" role="status" aria-live="polite">').text('Loading your connection…').appendTo(root);
    const topActions = $('<div class="carelink-top-actions">').appendTo(root);
    settingsButton = button('Connection settings', () => {
      setupOpen = !setupOpen; renderSession(session);
      if (setupOpen) country.trigger('focus');
    }, 'quiet').attr({ 'aria-expanded': 'false', 'aria-controls': 'carelink-setup' }).hide().appendTo(topActions);
    button('Refresh status', () => { requestError.hide(); void refresh(); }, 'quiet').appendTo(topActions);
    overview = $('<div class="carelink-overview">').hide().appendTo(root);
    details = $('<dl class="carelink-details">').appendTo(overview);
    function metric(label, name) {
      const item = $('<div class="carelink-metric">').append($('<dt>').text(label)).appendTo(details);
      return $('<dd>').addClass(name).text('Not yet').appendTo(item);
    }
    accountName = metric('CONNECTED ACCOUNT', 'carelink-account');
    lastReading = metric('LATEST READING', 'carelink-latest');
    lastSync = metric('LAST SUCCESSFUL CHECK', 'carelink-last-sync');
    steps = $('<ol class="carelink-steps" aria-label="Connection progress">').appendTo(root);
    ['Choose country', 'Sign in', 'Confirm account', 'Connected'].forEach((label, index) => {
      steps.append($('<li>').append($('<span class="carelink-step-number" aria-hidden="true">').text(index + 1)).append($('<span>').text(label)));
    });
    setupPanel = $('<div id="carelink-setup" class="carelink-setup">').appendTo(root);
    $('<h3>').text('Connect your account').appendTo(setupPanel);
    const setupRow = $('<div class="carelink-setup-row">').appendTo(setupPanel);
    const countryField = $('<div class="carelink-country-field">').appendTo(setupRow);
    country = $('<select class="carelink-select" id="carelink-country" aria-label="Country where your CareLink account is registered" aria-describedby="carelink-country-help">');
    country.on('change', () => { countryEdited = true; requestError.hide(); });
    country.append($('<option value="">').text('Choose your CareLink account country'));
    countryField.append($('<label for="carelink-country">').text('Account country')).append(country)
      .append($('<p class="carelink-help" id="carelink-country-help">').text('Use the country registered on your CareLink account.'));
    replace = $('<input type="checkbox">');
    setupPanel.append($('<label class="carelink-replace">').append(replace).append($('<span>')).hide());
    connectButton = button('Connect Medtronic', async function () {
      requestError.hide();
      if (!country.val()) {
        requestError.text('Choose your CareLink account country to continue.').show(); country.trigger('focus'); return;
      }
      connectButton.prop('disabled', true);
      dismissedSession = null;
      try {
        const width = Math.min(1000, Math.max(320, root.width()));
        const height = Math.min(900, Math.max(520, window.innerHeight - 180));
        renderSession(await api('POST', '/sessions', { country: country.val(), width, height, replace: replace.prop('checked') }));
        await refresh();
      } catch (err) { error(err); connectButton.prop('disabled', false); }
    }, 'primary');
    disconnectButton = button('Disconnect', async () => {
      if (!window.confirm('Stop CareLink imports and remove its saved login? Your historical Nightscout data will be kept.')) return;
      requestError.hide();
      try { await api('DELETE', ''); setupOpen = false; await refresh(); } catch (err) { error(err); }
    }, 'danger').hide();
    setupRow.append($('<div class="carelink-setup-actions">').append(connectButton).append(disconnectButton));
    $('<div class="carelink-privacy">').append(symbol('shield')).append($('<p>').text('Sign in on Medtronic’s own page. Your password is not saved, and the temporary browser closes when you finish.')).appendTo(setupPanel);
    requestError = $('<div class="carelink-request-error" role="alert">').hide().appendTo(root);
    panel = $('<div class="carelink-panel">').hide().appendTo(root);
    feedback = $('<div class="carelink-feedback" role="region" aria-labelledby="carelink-feedback-title" aria-describedby="carelink-feedback-text" tabindex="-1">').appendTo(panel);
    feedbackIcon = $('<div class="carelink-feedback-icon" aria-hidden="true">').appendTo(feedback);
    const feedbackBody = $('<div class="carelink-feedback-body">').appendTo(feedback);
    feedbackTitle = $('<h3 id="carelink-feedback-title">').appendTo(feedbackBody);
    feedbackText = $('<p id="carelink-feedback-text">').appendTo(feedbackBody);
    technicalDetails = $('<details class="carelink-technical">').append($('<summary>').text('Technical details')).hide().appendTo(feedbackBody);
    feedbackDiagnostic = $('<p class="carelink-diagnostic">').appendTo(technicalDetails);
    const feedbackActions = $('<div class="carelink-feedback-actions">').appendTo(feedbackBody);
    retryButton = button('Try signing in again', () => { if (!connectButton.prop('disabled')) connectButton.trigger('click'); }, 'primary').hide().appendTo(feedbackActions);
    dismissButton = button('Dismiss', () => { dismissedSession = session.id; requestError.hide(); void refresh(); }, 'quiet').hide().appendTo(feedbackActions);
    browserFrame = $('<div class="carelink-browser">').hide().appendTo(panel);
    $('<div class="carelink-browser-bar">').append($('<span class="carelink-browser-title">').text('Medtronic sign-in'))
      .append($('<span class="carelink-private-label">').append(symbol('shield')).append($('<span>').text('Private session'))).appendTo(browserFrame);
    browserLoading = $('<div class="carelink-browser-loading" role="status">').append($('<span class="carelink-spinner" aria-hidden="true">'))
      .append($('<p>').text('Loading Medtronic’s sign-in page…')).appendTo(browserFrame);
    image = $('<img class="carelink-screen" alt="Live Medtronic sign-in page. Tap a field to type, or use the keyboard controls below." draggable="false">').appendTo(browserFrame);
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
    const controls = $('<div class="carelink-input-controls">').appendTo(browserFrame);
    controls.append(button('Previous field', () => send({ type: 'key', key: 'Tab', shift: true })))
      .append(button('Next field', () => send({ type: 'key', key: 'Tab' })))
      .append(button('Keyboard', () => relay.toggleClass('carelink-keyboard-visible').trigger('focus')))
      .append(button('Enter', () => send({ type: 'key', key: 'Enter' })));
    focusLabel = $('<p class="carelink-focus" aria-live="polite">').appendTo(controls);
    patientBox = $('<div class="carelink-patients">').appendTo(panel);
    cancelButton = button('Cancel sign-in', async () => {
      requestError.hide();
      try { await api('DELETE', '/sessions/' + session.id); await refresh(); } catch (err) { error(err); }
    }, 'quiet').appendTo(panel);
    api('GET', '/countries').then(countries => {
      if (!Array.isArray(countries)) throw new Error('Invalid countries');
      countries.forEach(c => country.append($('<option>').val(c.code).text(c.name)));
      return refresh();
    }).catch(error);
    window.addEventListener('pagehide', () => { running = false; pageWindow.clearTimeout(timer); relay.val(''); image.removeAttr('src'); });
    if (window.location.hash === '#carelink') root[0].scrollIntoView();
  }
  return { mount, refresh };
};
