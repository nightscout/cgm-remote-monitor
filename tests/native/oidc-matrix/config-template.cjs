'use strict';

// Builds the matrix configuration for one attempt. Public keys, synthetic tenant
// IDs, the executed source root/commit and the owned Vault origin are inputs;
// every credential is an environment reference, never a value.
const OREF_COMMIT = 'd219baf9559d62a8bb0bd42014192a2d7c0839ef';
module.exports = function template ({ nonce, tenants, publicKeys, sourceRoot, sourceCommit, vaultAddress, oref0Root, tools }) {
  if (!/^[a-f0-9]{16,32}$/.test(nonce) || !Array.isArray(tenants) || tenants.length !== 2 ||
      !Array.isArray(publicKeys) || publicKeys.length !== 2 || !/^[0-9a-f]{40}$/.test(sourceCommit || '') ||
      typeof sourceRoot !== 'string' || !sourceRoot.startsWith('/') || typeof vaultAddress !== 'string' ||
      typeof oref0Root !== 'string' || !tools) throw new TypeError('Explicit nonce/tenants/public keys/source/vault/tools required');
  const ns = suffix => 'oc_' + nonce + '_' + suffix;
  return { nonce, sourceCommit, sourceRoot, tenants,
    execution:require('./stage-contract.cjs').template(), operatorCredentialEnv:'OWNER_PRIVATE_OPERATOR_TOKEN',
    singleCompatibility:{apiSecretEnv:'OWNER_SINGLE_API_SECRET',jwtKeyEnv:'OWNER_SINGLE_JWT_KEY'},
    consumerJourney:{connectionEnv:'OWNER_CLINICAL_PG',
      namespaces:Object.fromEntries(['entries','treatments','devicestatus','profile','food','activity','clock','checkpoint'].map(name=>[name,'cj_'+nonce+'_'+name])),
      client:{root:oref0Root,commit:OREF_COMMIT,maxMs:10000,caEnv:'HUMAN_HTTPS_CERT',tools}},
    fixturePolicy:{ceiling:['*'],delegable:['*']},adminConnectionEnv:'HUMAN_SESSION_PG_ADMIN_URL',
    humanConnectionEnv:'HUMAN_SESSION_PG_APP_URL',settingsReaderConnectionEnv:'OWNER_DISPLAY_PG',
    ownerPreview:{version:1,postgres:{writerConnectionEnv:'OWNER_WRITE_PG',accessConnectionEnv:'OWNER_READ_PG',
      namespaces:{authorization:'$native.authority',access:'$native.access',credentials:ns('legacy')}},
      ownerPolicy:{catalogue:['*']},resolution:{mode:'direct-alias'},
      tenants:[{id:tenants[0],aliases:['localhost']},{id:tenants[1],aliases:['foreign.synthetic.invalid']}],
      management:{issuer:'synthetic-headless-owner',audience:'synthetic-owner-management',purpose:'management',consumer:'oidc',
        keys:tenants.map((tenant,index)=>({tenant,kid:'owner'+index,publicKey:publicKeys[index]}))},
      ownerSettings:{connectionEnv:'OWNER_SETTINGS_PG',namespaces:{settings:ns('settings'),operatorPolicy:ns('policy'),authority:ns('configure')}},
      ownerCredentials:{connectionEnv:'OWNER_SECRETS_PG',namespace:ns('secrets'),
        vault:{address:vaultAddress,mount:'transit',allowInsecureLoopback:false},
        tenants:tenants.map((id,index)=>({id,tokenEnv:index?'OWNER_TOKEN_B':'OWNER_TOKEN_A',
          encryptionKey:'owner-encrypt-'+index,signingKey:'owner-sign-'+index,signingVersion:1}))}}
  };
};
module.exports.OREF_COMMIT = OREF_COMMIT;
