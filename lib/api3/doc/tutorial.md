# APIv3: Basics tutorial

Nightscout API v3 is a component of [cgm-remote-monitor](https://github.com/nightscout/cgm-remote-monitor) project. 
It aims to provide lightweight, secured and HTTP REST compliant interface for your T1D treatment data exchange.

There is a list of REST operations that the API v3 offers (inside `/api/v3` relative URL namespace), we will briefly introduce them in this file.

Each NS instance with API v3 contains self-included OpenAPI specification at [/api/v3/swagger-ui-dist/](https://nsapiv3.herokuapp.com/api/v3/swagger-ui-dist/) relative URL.


---
###  VERSION

[VERSION](https://nsapiv3.herokuapp.com/api/v3/swagger-ui-dist/#/other/get_version) operation gets you basic information about software packages versions.
It is public (there is no need to add authorization parameters/headers).

Sample GET `/version` client code:
```javascript
const request = require('request');

request('https://nsapiv3.herokuapp.com/api/v3/version',
  (error, response, body) => console.log(body));
```
Sample result:
```javascript
{  
   "version":"0.12.2",
   "apiVersion":"3.0.0-alpha",
   "srvDate":1564386001772,
   "storage":{  
      "storage":"mongodb",
      "version":"3.6.12"
   }
}
```


---
###  STATUS

[STATUS](https://nsapiv3.herokuapp.com/api/v3/swagger-ui-dist/#/other/get_status) operation gets you basic information about software packages versions.
It is public (there is no need to add authorization parameters/headers).

Sample GET `/version` client code:
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5&now=${new Date().getTime()}`;

request(`https://nsapiv3.herokuapp.com/api/v3/status?${auth}`,
  (error, response, body) => console.log(body));
```
Sample result:
```javascript
{  
  "version":"0.12.2",
  "apiVersion":"3.0.0-alpha",
  "srvDate":1564391740738,
  "storage":{  
    "storage":"mongodb",
    "version":"3.6.12"
  },
  "apiPermissions":{  
    "devicestatus":"crud",
    "entries":"crud",
    "food":"crud",
    "profile":"crud",
    "settings":"crud",
    "treatments":"crud"
  }
}
```
`"crud"` represents create + read + update + delete permissions for the collection.


---
###  CREATE

[CREATE](https://nsapiv3.herokuapp.com/api/v3/swagger-ui-dist/#/generic/post__collection_) operation inserts a new document into the collection.

Sample POST `/treatments` client code:
```javascript
const request = require('request');
const uuid = require('uuid/v4');
const auth = `token=testadmin-ad3b1f9d7b3f59d5&now=${new Date().getTime()}`;
const doc = {
  identifier: uuid(),
  date: (new Date()).getTime(),
  app: 'tutorial',
  eventType: 'Correction Bolus',
  insulin: 0.3
};

request({
    method: 'post',
    body: doc,
    json: true,
    url: `https://nsapiv3.herokuapp.com/api/v3/treatments?${auth}`
  },
  (error, response, body) => console.log(response.headers.location));
```
Sample result:
```
/api/v3/treatments/2f47662b-270e-446f-8f13-7402411b0b2f
```


---
###  READ

[READ](https://nsapiv3.herokuapp.com/api/v3/swagger-ui-dist/#/generic/get__collection___identifier_) operation retrieves you a single document from the collection by its identifier.

Sample GET `/treatments/{identifier}` client code:
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5&now=${new Date().getTime()}`;
const identifier = '2f47662b-270e-446f-8f13-7402411b0b2f';

request(`https://nsapiv3.herokuapp.com/api/v3/treatments/${identifier}?${auth}`,
  (error, response, body) => console.log(body));
```
Sample result:
```
{  
  "identifier":"2f47662b-270e-446f-8f13-7402411b0b2f",
  "date":1564469301415,
  "app":"tutorial",
  "eventType":"Correction Bolus",
  "insulin":0.3,
  "utcOffset":0,
  "created_at":"2019-07-30T06:48:21.415Z",
  "srvModified":1564469314674,
  "srvCreated":1564469314674,
  "subject":"test-admin"
}
```
