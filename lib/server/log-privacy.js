'use strict';

// Diagnostic URLs never need credentials, queries or fragments. Drop the whole
// query rather than maintaining a list of every possible credential spelling.
function urlForLog (value) {
  if (typeof value !== 'string') return '[invalid URL]';
  if (['inline', 'eval', 'self', 'none'].includes(value)) return value;
  try {
    const absolute = /^https?:\/\//i.test(value);
    const parsed = new URL(value, 'http://nightscout.invalid');
    if (!['http:', 'https:'].includes(parsed.protocol)) return parsed.protocol;
    const pathname = parsed.pathname.replace(/(\/authorization\/request\/)[^/]+/ig, '$1[REDACTED]');
    return ((absolute ? parsed.origin : '') + pathname).slice(0, 2048);
  } catch {
    return '[invalid URL]';
  }
}

function errorForLog (error, req) {
  const query = req.query || {};
  const headers = req.headers || {};
  const credentials = new Set();
  const values = [query.token, query.secret, headers['api-secret'], headers.authorization,
    req.api_secret, req.auth_token, req.params && req.params.accessToken];
  const pathToken = /\/authorization\/request\/([^/?#]+)/i.exec(req.originalUrl || req.url || '');
  if (pathToken) {
    values.push(pathToken[1]);
    try { values.push(decodeURIComponent(pathToken[1])); } catch {
      // A malformed path still has its raw value redacted.
    }
  }
  for (const value of values.flat()) {
    if (typeof value !== 'string' || !value) continue;
    credentials.add(value);
    try { credentials.add(encodeURIComponent(value)); } catch {
      // An invalid Unicode scalar must not break error handling.
    }
    credentials.add(JSON.stringify(value).slice(1, -1));
    if (/^Bearer /i.test(value) && value.length > 7) credentials.add(value.slice(7));
  }
  const secrets = [...credentials].sort((a, b) => b.length - a.length);
  function text (value) {
    if (typeof value !== 'string') return undefined;
    if (value.length > 8192) return '[oversized diagnostic omitted]';
    // Redact whole sensitive lines before parsing URLs: replacing a credential
    // such as "/" inside a URL could otherwise hide its scheme from redaction.
    if (secrets.some(secret => /[\r\n]/.test(secret) && value.includes(secret))) return '[REDACTED]';
    const safe = value.split('\n').map(function (line) {
      if (secrets.some(secret => line.includes(secret))) return '[REDACTED]';
      // Tokenization avoids backtracking on long relative paths without a query.
      return line.replace(/[^\s"'<>]+/g, function (word) {
        const absolute = word.search(/https?:\/\/|mongodb(?:\+srv)?:\/\//i);
        const slash = word.indexOf('/');
        if (slash >= 0 && (absolute < 0 || slash < absolute) &&
            (word.includes('?') || word.includes('#') || /\/authorization\/request\//i.test(word))) {
          return word.slice(0, slash) + urlForLog(word.slice(slash));
        }
        if (absolute >= 0) return word.slice(0, absolute) + urlForLog(word.slice(absolute));
        return word;
      });
    }).join('\n');
    return safe.slice(0, 8192);
  }
  return {
    name: text(error && error.name),
    code: typeof (error && error.code) === 'number' ? error.code : text(error && error.code),
    message: text(error && error.message),
    stack: text(error && error.stack)
  };
}

function cspReportForLog (body) {
  const report = body && body['csp-report'];
  if (!report || typeof report !== 'object' || Array.isArray(report)) return {};
  const safe = {};
  for (const field of ['document-uri', 'blocked-uri', 'source-file', 'referrer']) {
    if (typeof report[field] === 'string') safe[field] = urlForLog(report[field]);
  }
  for (const field of ['effective-directive', 'violated-directive']) {
    if (typeof report[field] !== 'string') continue;
    const directive = report[field].split(/\s/, 1)[0];
    if (/^[a-z][a-z-]{0,63}$/.test(directive)) safe[field] = directive;
  }
  for (const field of ['line-number', 'column-number', 'status-code']) {
    if (Number.isSafeInteger(report[field]) && report[field] >= 0) safe[field] = report[field];
  }
  // original-policy, script-sample and unknown fields may contain credentials
  // or user data. They are deliberately excluded from diagnostic output.
  return safe;
}

module.exports = {urlForLog, errorForLog, cspReportForLog};
