# APIv3: Basics tutorial

Nightscout API v3 is a component of [cgm-remote-monitor](https://github.com/nightscout/cgm-remote-monitor) project. 
It aims to provide lightweight, secured and HTTP REST compliant interface for your T1D treatment data exchange.

There is a list of REST operations that the API v3 offers (inside `/api/v3` relative URL namespace), we will briefly introduce them in this file.

Each NS instance with API v3 contains self-included OpenAPI specification at [/api/v3/swagger-ui-dist/](https://nsapiv3.herokuapp.com/api/v3/swagger-ui-dist/) relative URL.


---
###  VERSION

[VERSION](https://nsapiv3.herokuapp.com/api/v3/swagger-ui-dist/#/other/get_version) operation gets you basic information about software packages versions.
It is public (there is no need to add authorization parameters/headers).

Sample GET `/version` client code (to get actual versions):
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

Sample GET `/status` client code (to get my actual permissions):
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
###  SEARCH

[SEARCH](https://nsapiv3insecure.herokuapp.com/api/v3/swagger-ui-dist/index.html#/generic/SEARCH) operation filters, sorts, paginates and projects documents from the collection.

Sample GET `/entries` client code (to retrieve last 3 BG values):
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5&now=${new Date().getTime()}`;

request(`https://nsapiv3.herokuapp.com/api/v3/entries?${auth}&sort$desc=date&limit=3&fields=dateString,sgv,direction`,
  (error, response, body) => console.log(body));
```
Sample result:
```
[  
  {  
    "dateString":"2019-07-30T02:24:50.434+0200",
    "sgv":115,
    "direction":"FortyFiveDown"
  },
  {  
    "dateString":"2019-07-30T02:19:50.374+0200",
    "sgv":121,
    "direction":"FortyFiveDown"
  },
  {  
    "dateString":"2019-07-30T02:14:50.450+0200",
    "sgv":129,
    "direction":"FortyFiveDown"
  }
]
```


---
###  CREATE

[CREATE](https://nsapiv3.herokuapp.com/api/v3/swagger-ui-dist/#/generic/post__collection_) operation inserts a new document into the collection.

Sample POST `/treatments` client code:
```javascript
const request = require('request');
const uuidv5 = require('uuid/v5');
const auth = `token=testadmin-ad3b1f9d7b3f59d5&now=${new Date().getTime()}`;
const doc = {
  date: (new Date()).getTime(),
  app: 'AndroidAPS',
  device: 'Samsung XCover 4',
  eventType: 'Correction Bolus',
  insulin: 0.3
};
// let's create "deduplication ready" identifier, combining
// treatment type + originating device + timestamp + type specific measurement value
// (insulin dose or bg or carbs or a combination thereof)
const combination = `${doc.device}|${doc.eventType}|${doc.date}|${doc.insulin}`;
doc.identifier = uuidv5(combination, '00000000-0000-0000-0000-000000000000');

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
/api/v3/treatments/3e7c3a33-28da-584d-9447-434d1b4488f7
```


---
###  READ

[READ](https://nsapiv3.herokuapp.com/api/v3/swagger-ui-dist/#/generic/get__collection___identifier_) operation retrieves you a single document from the collection by its identifier.

Sample GET `/treatments/{identifier}` client code:
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5&now=${new Date().getTime()}`;
const identifier = '3e7c3a33-28da-584d-9447-434d1b4488f7';

request(`https://nsapiv3.herokuapp.com/api/v3/treatments/${identifier}?${auth}`,
  (error, response, body) => console.log(body));
```
Sample result:
```
{  
  "date":1564521267421,
  "app":"AndroidAPS",
  "device":"Samsung XCover 4",
  "eventType":"Correction Bolus",
  "insulin":0.3,
  "identifier":"3e7c3a33-28da-584d-9447-434d1b4488f7",
  "utcOffset":0,
  "created_at":"2019-07-30T21:14:27.421Z",
  "srvModified":1564521267847,
  "srvCreated":1564521267847,
  "subject":"test-admin"
}
```


---
###  LAST MODIFIED

[LAST MODIFIED](https://nsapiv3insecure.herokuapp.com/api/v3/swagger-ui-dist/index.html#/other/LAST-MODIFIED) operation finds the date of last modification for each collection.

Sample GET `/lastModified` client code (to get latest modification dates):
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5&now=${new Date().getTime()}`;

request(`https://nsapiv3.herokuapp.com/api/v3/lastModified?${auth}`,
  (error, response, body) => console.log(body));
```
Sample result:
```javascript
{
  "srvDate":1564522409676,
  "collections":{
    "devicestatus":1564522191273,
    "entries":1564522189185,
    "profile":1548524042744,
    "treatments":1564521267847
  }
}
```


---
###  UPDATE

[UPDATE](https://nsapiv3insecure.herokuapp.com/api/v3/swagger-ui-dist/index.html#/generic/put__collection___identifier_) operation updates an existing document in the collection.

Sample PUT `/treatments` client code (to update `insulin` from 0.3 to 0.4):
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5&now=${new Date().getTime()}`;
const identifier = '3e7c3a33-28da-584d-9447-434d1b4488f7';
const doc = {
  date: 1564521267421,
  app: 'AndroidAPS',
  device: 'Samsung XCover 4',
  eventType: 'Correction Bolus',
  insulin: 0.4
};

request({
    method: 'put',
    body: doc,
    json: true,
    url: `https://nsapiv3.herokuapp.com/api/v3/treatments/${identifier}?${auth}`
  },
  (error, response, body) => console.log(response.statusCode));
```
Sample result:
```
204
```