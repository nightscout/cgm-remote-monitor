'use strict';

const { request, providerUrl } = require('./http');
const ConnectError = require('../../errors');

module.exports = function createClient(http = request) {
  function call(connection, path, body, operation = 'glucose_data') {
    const base = 'https://carelink.minimed.' + (connection.region === 'us' ? 'com' : 'eu');
    const url = providerUrl(new URL(path, base).href);
    return http(url.href, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), operation,
      headers: { Authorization: 'Bearer ' + connection.tokens.accessToken,
        'Content-Type': 'application/json', 'Accept-Language': 'en' } });
  }
  async function account(connection) {
    const [user, profile, requirements] = await Promise.all([
      call(connection, '/patient/users/me', undefined, 'account_details'), call(connection, '/patient/users/me/profile', undefined, 'account_profile'),
      call(connection, '/patient/countries/settings?countryCode=' + connection.country + '&language=en', undefined, 'country_settings')
    ]);
    const isPatient = ['PATIENT', 'PATIENT_US', 'PATIENT_OUS'].includes(user.role);
    let patients;
    if (isPatient) patients = [{ username: profile.username, label: profile.username }];
    else {
      const links = await call(connection, '/patient/m2m/links/patients', undefined, 'patient_list');
      if (!Array.isArray(links)) throw new ConnectError('no_patients', 422);
      patients = links.filter(p => typeof p.username === 'string').map(p => ({ username: p.username,
        label: [p.firstName, p.lastName].filter(Boolean).join(' ') || p.username }));
    }
    if (!patients.length || patients.some(p => !p.username)) throw new ConnectError('no_patients', 422);
    return { username: profile.username, isPatient, patients, requirements };
  }
  async function data(connection, session) {
    const patient = connection.patient;
    if (!session.patients.some(p => p.username === patient)) throw new ConnectError('patient_unavailable', 422);
    const attempts = [];
    // A follower must never fall back to their own personal monitor/uploads.
    if (session.requirements.blePereodicDataEndpoint) {
      attempts.push(() => call(connection, session.requirements.blePereodicDataEndpoint,
        session.isPatient ? { username: session.username, role: 'patient' } :
          { username: session.username, role: 'carepartner', patientId: patient }));
    }
    attempts.push(() => call(connection, '/patient/m2m/connect/data/gc/patients/' + encodeURIComponent(patient) +
      '?cpSerialNumber=NONE&msgType=last24hours&requestTime=' + Date.now()));
    if (session.isPatient) {
      attempts.push(() => call(connection, '/patient/monitor/data'));
      attempts.push(() => call(connection, '/patient/dataUpload/recentUploads?numUploads=1'));
    }
    let empty;
    for (const attempt of attempts) {
      try {
        const result = await attempt();
        if (Array.isArray(result.sgs)) {
          if (result.sgs.length) return result;
          empty = result;
        }
      } catch (err) {
        if (err.code === 'reconnect_required') throw err;
      }
    }
    if (empty) return empty;
    throw new ConnectError('provider_unavailable', 502);
  }
  return { account, data };
};
