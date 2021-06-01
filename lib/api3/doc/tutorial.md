# APIv3: Basics tutorial

Nightscout API v3 is a component of [cgm-remote-monitor](https://github.com/nightscout/cgm-remote-monitor) project. 
It aims to provide lightweight, secured and HTTP REST compliant interface for your T1D treatment data exchange.

There is a list of REST operations that the API v3 offers (inside `/api/v3` relative URL namespace), we will briefly introduce them in this file.

Each NS instance with API v3 contains self-included OpenAPI specification at [/api/v3/swagger-ui-dist/](https://nsapiv3.herokuapp.com/api/v3/swagger-ui-dist/) relative URL.


---
###  VERSION

[VERSION](https://nsapiv3.herokuapp.com/api3-docs/#/other/get_version) operation gets you basic information about software packages versions.
It is public (there is no need to add authorization parameters/headers).

Sample GET `/version` client code (to get actual versions):
```javascript
const request = require('request');

request('https://nsapiv3.herokuapp.com/api/v3/version',
  (error, response, body) => console.log(body));
```
Sample result:
```json
{
  "status": 200,
  "result": {
    "version": "14.1.0",
    "apiVersion": "3.0.2-alpha",
    "srvDate": 1609402081548,
    "storage": {
      "storage": "mongodb",
      "version": "4.2.11"
    }
  }
}
```


---
###  STATUS

[STATUS](https://nsapiv3.herokuapp.com/api3-docs/#/other/get_status) operation gets you basic information about software packages versions.
It is public (there is no need to add authorization parameters/headers).

Sample GET `/status` client code (to get my actual permissions):
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5`;

request(`https://nsapiv3.herokuapp.com/api/v3/status?${auth}`,
  (error, response, body) => console.log(body));
```
Sample result:
```json
{
  "status": 200,
  "result": {
    "version": "14.1.0",
    "apiVersion": "3.0.2-alpha",
    "srvDate": 1609427571833,
    "storage": {
      "storage": "mongodb",
      "version": "4.2.11"
    },
    "apiPermissions": {
      "devicestatus": "crud",
      "entries": "crud",
      "food": "crud",
      "profile": "crud",
      "settings": "crud",
      "treatments": "crud"
    }
  }
}
```
`"crud"` represents create + read + update + delete permissions for the collection.


---
###  SEARCH

[SEARCH](https://nsapiv3insecure.herokuapp.com/api3-docs/#/generic/SEARCH) operation filters, sorts, paginates and projects documents from the collection.

Sample GET `/entries` client code (to retrieve last 3 BG values):
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5`;

request(`https://nsapiv3.herokuapp.com/api/v3/entries?${auth}&sort$desc=date&limit=3&fields=dateString,sgv,direction`,
  (error, response, body) => console.log(body));
```
Sample result:
```json
{
  "status": 200, 
  "result": [  
    {  
      "dateString": "2019-07-30T02:24:50.434+0200",
      "sgv": 115,
      "direction": "FortyFiveDown"
    },
    {  
      "dateString": "2019-07-30T02:19:50.374+0200",
      "sgv": 121,
      "direction": "FortyFiveDown"
    },
    {  
      "dateString": "2019-07-30T02:14:50.450+0200",
      "sgv": 129,
      "direction": "FortyFiveDown"
    }
  ]
}
```


---
###  CREATE

[CREATE](https://nsapiv3.herokuapp.com/api3-docs/#/generic/post__collection_) operation inserts a new document into the collection.

Sample POST `/treatments` client code:
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5`;
const doc = {
  date: 1564591511232, // (new Date()).getTime(),
  app: 'AndroidAPS',
  device: 'Samsung XCover 4-861536030196001',
  eventType: 'Correction Bolus',
  insulin: 0.3
};
request({
    method: 'post',
    body: doc,
    json: true,
    url: `https://nsapiv3.herokuapp.com/api/v3/treatments?${auth}`
  },
  (error, response, body) => console.log(body));
```
Sample result:
```json
{
  "status": 201,
  "identifier": "95e1a6e3-1146-5d6a-a3f1-41567cae0895",
  "lastModified": 1564591511711
}
```


---
###  READ

[READ](https://nsapiv3.herokuapp.com/api3-docs/#/generic/get__collection___identifier_) operation retrieves you a single document from the collection by its identifier.

Sample GET `/treatments/{identifier}` client code:
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5`;
const identifier = '95e1a6e3-1146-5d6a-a3f1-41567cae0895';

request(`https://nsapiv3.herokuapp.com/api/v3/treatments/${identifier}?${auth}`,
  (error, response, body) => console.log(body));
```
Sample result:
```json
{
  "status": 200,
  "result": {  
    "date": 1564591511232,
    "app": "AndroidAPS",
    "device": "Samsung XCover 4-861536030196001",
    "eventType": "Correction Bolus",
    "insulin": 0.3,
    "identifier": "95e1a6e3-1146-5d6a-a3f1-41567cae0895",
    "utcOffset": 0,
    "created_at": "2019-07-31T16:45:11.232Z",
    "srvModified": 1564591627732,
    "srvCreated": 1564591511711,
    "subject": "test-admin"
  }
}
```


---
###  LAST MODIFIED

[LAST MODIFIED](https://nsapiv3insecure.herokuapp.com/api3-docs/#/other/LAST-MODIFIED) operation finds the date of last modification for each collection.

Sample GET `/lastModified` client code (to get latest modification dates):
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5`;

request(`https://nsapiv3.herokuapp.com/api/v3/lastModified?${auth}`,
  (error, response, body) => console.log(body));
```
Sample result:
```json
{  
  "status": 200,
  "result": {  
    "srvDate": 1564591783202,
    "collections": {  
      "devicestatus": 1564591490074,
      "entries": 1564591486801,
      "profile": 1548524042744,
      "treatments": 1564591627732
    }
  }
}
```


---
###  UPDATE

[UPDATE](https://nsapiv3insecure.herokuapp.com/api3-docs/#/generic/put__collection___identifier_) operation updates existing document in the collection.

Sample PUT `/treatments/{identifier}` client code (to update `insulin` from 0.3 to 0.4):
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5`;
const identifier = '95e1a6e3-1146-5d6a-a3f1-41567cae0895';
const doc = {
  date: 1564591511232,
  app: 'AndroidAPS',
  device: 'Samsung XCover 4-861536030196001',
  eventType: 'Correction Bolus',
  insulin: 0.4
};

request({
    method: 'put',
    body: doc,
    json: true,
    url: `https://nsapiv3.herokuapp.com/api/v3/treatments/${identifier}?${auth}`
  },
  (error, response, body) => console.log(body));
```
Sample result:
```json
{
  "status": 200
}
```


---
###  PATCH

[PATCH](https://nsapiv3insecure.herokuapp.com/api3-docs/#/generic/patch__collection___identifier_) operation partially updates existing document in the collection.

Sample PATCH `/treatments/{identifier}` client code (to update `insulin` from 0.4 to 0.5):
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5`;
const identifier = '95e1a6e3-1146-5d6a-a3f1-41567cae0895';
const doc = {
  insulin: 0.5
};

request({
    method: 'patch',
    body: doc,
    json: true,
    url: `https://nsapiv3.herokuapp.com/api/v3/treatments/${identifier}?${auth}`
  },
  (error, response, body) => console.log(body));
```
Sample result:
```json
{
  "status": 200
}
```


---
###  DELETE

[DELETE](https://nsapiv3insecure.herokuapp.com/api3-docs/#/generic/delete__collection___identifier_) operation deletes existing document from the collection.

Sample DELETE `/treatments/{identifier}` client code (to update `insulin` from 0.4 to 0.5):
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5`;
const identifier = '95e1a6e3-1146-5d6a-a3f1-41567cae0895';

request({
    method: 'delete',
    url: `https://nsapiv3.herokuapp.com/api/v3/treatments/${identifier}?${auth}`
  },
  (error, response, body) => console.log(body));
```
Sample result:
```json
{
  "status": 200
}
```


---
###  HISTORY

[HISTORY](https://nsapiv3insecure.herokuapp.com/api3-docs/#/generic/HISTORY2) operation queries all changes since the timestamp.

Sample HISTORY `/treatments/history/{lastModified}` client code:
```javascript
const request = require('request');
const auth = `token=testadmin-ad3b1f9d7b3f59d5`;
const lastModified = 1564521267421;

request(`https://nsapiv3.herokuapp.com/api/v3/treatments/history/${lastModified}?${auth}`,
  (error, response, body) => console.log(response.body));
```
Sample result:
```json
{
  "status": 200,
  "result": [
    {
      "date": 1564521267421,
      "app": "AndroidAPS",
      "device": "Samsung XCover 4-861536030196001",
      "eventType": "Correction Bolus",
      "insulin": 0.5,
      "utcOffset": 0,
      "created_at": "2019-07-30T21:14:27.421Z",
      "identifier": "95e1a6e3-1146-5d6a-a3f1-41567cae0895",
      "srvModified": 1564592440416,
      "srvCreated": 1564592334853,
      "subject": "test-admin",
      "modifiedBy": "test-admin",
      "isValid": false
    },
    {
      "date": 1564592545299,
      "app": "AndroidAPS",
      "device": "Samsung XCover 4-861536030196001",
      "eventType": "Snack Bolus",
      "carbs": 10,
      "identifier": "267c43c2-f629-5191-a542-4f410c69e486",
      "utcOffset": 0,
      "created_at": "2019-07-31T17:02:25.299Z",
      "srvModified": 1564592545781,
      "srvCreated": 1564592545781,
      "subject": "test-admin"
    }
  ]
}
```
Notice the `"isValid":false` field marking the deletion of the document.
