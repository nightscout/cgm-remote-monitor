'use strict';

const ConnectionString = require('mongodb-connection-string-url').default;

// Driver 7 requires an AWS credential provider instead of credentials in the
// URI. Adapt the existing configuration without changing non-AWS connections
// or putting AWS secrets into process.env (which could affect other clients).
module.exports = function mongoClientConfiguration(uri, options = {}) {
  const parsed = new ConnectionString(uri);
  const mechanisms = [...parsed.searchParams].filter(([key]) => key.toLowerCase() === 'authmechanism');
  if (mechanisms.length !== 1 || mechanisms[0][1].toUpperCase() !== 'MONGODB-AWS') {
    return {uri, options};
  }

  let sessionToken;
  const retainedProperties = [];
  let propertyKey;
  const parameters = [...parsed.searchParams];
  parsed.search = '';
  for (const [key, value] of parameters) {
    if (key.toLowerCase() !== 'authmechanismproperties') {
      parsed.searchParams.append(key, value);
      continue;
    }
    propertyKey = key;
    if (value === '') continue;
    for (const pair of value.split(',')) {
      const separator = pair.indexOf(':');
      if (pair.slice(0, separator) === 'AWS_SESSION_TOKEN') {
        sessionToken = pair.slice(separator + 1);
      } else {
        retainedProperties.push(pair);
      }
    }
  }
  if (retainedProperties.length) parsed.searchParams.append(propertyKey, retainedProperties.join(','));

  const accessKeyId = decodeURIComponent(parsed.username) || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = decodeURIComponent(parsed.password) || process.env.AWS_SECRET_ACCESS_KEY;
  if (sessionToken == null) sessionToken = process.env.AWS_SESSION_TOKEN;
  parsed.username = '';
  parsed.password = '';

  // Keep URI-over-environment precedence for static credentials. Without a
  // static access key, leave metadata/refresh to the driver's standard SDK
  // chain rather than implementing EC2/ECS credential handling locally.
  if (!accessKeyId) return {uri:parsed.toString(), options};
  if (!secretAccessKey) throw new Error('MONGODB-AWS requires a secret access key for the configured access key');

  const provider = async () => ({accessKeyId, secretAccessKey, ...(sessionToken ? {sessionToken} : {})});
  return {
    uri:parsed.toString(),
    options:{...options, authMechanismProperties:{
      ...options.authMechanismProperties,
      AWS_CREDENTIAL_PROVIDER:provider
    }}
  };
};
