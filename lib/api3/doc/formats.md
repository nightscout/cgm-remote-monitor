# APIv3: Output formats

### Choosing output format
In APIv3, the standard content type is JSON for both HTTP request and HTTP response.  
However, in HTTP response, the response content type can be changed to XML or CSV 
for READ, SEARCH, and HISTORY operations.

The response content type can be requested in one of the following ways:
- add a file type extension to the URL, eg. 
  `/api/v3/entries.csv?...`
   or `/api/v3/treatments/95e1a6e3-1146-5d6a-a3f1-41567cae0895.xml?...`
- set `Accept` HTTP request header to `text/csv` or `application/xml`

The server replies with `406 Not Acceptable` HTTP status in case of not supported content type.  


### JSON

Default content type is JSON, output can look like this:

```
[
  {
    "type":"sgv",
    "sgv":"171",
    "dateString":"2014-07-19T02:44:15.000-07:00",
    "date":1405763055000,
    "device":"dexcom",
    "direction":"Flat",
    "identifier":"5c5a2404e0196f4d3d9a718a",
    "srvModified":1405763055000,
    "srvCreated":1405763055000
  },
  {
    "type":"sgv",
    "sgv":"176",
    "dateString":"2014-07-19T03:09:15.000-07:00",
    "date":1405764555000,
    "device":"dexcom",
    "direction":"Flat",
    "identifier":"5c5a2404e0196f4d3d9a7187",
    "srvModified":1405764555000,
    "srvCreated":1405764555000
  }
]
```

### XML

Sample output:

```
<?xml version='1.0' encoding='utf-8'?>
<items>
  <item>
    <type>sgv</type>
    <sgv>171</sgv>
    <dateString>2014-07-19T02:44:15.000-07:00</dateString>
    <date>1405763055000</date>
    <device>dexcom</device>
    <direction>Flat</direction>
    <identifier>5c5a2404e0196f4d3d9a718a</identifier>
    <srvModified>1405763055000</srvModified>
    <srvCreated>1405763055000</srvCreated>
  </item>
  <item>
    <type>sgv</type>
    <sgv>176</sgv>
    <dateString>2014-07-19T03:09:15.000-07:00</dateString>
    <date>1405764555000</date>
    <device>dexcom</device>
    <direction>Flat</direction>
    <identifier>5c5a2404e0196f4d3d9a7187</identifier>
    <srvModified>1405764555000</srvModified>
    <srvCreated>1405764555000</srvCreated>
  </item>
</items>
```

### CSV

Sample output:

```
type,sgv,dateString,date,device,direction,identifier,srvModified,srvCreated
sgv,171,2014-07-19T02:44:15.000-07:00,1405763055000,dexcom,Flat,5c5a2404e0196f4d3d9a718a,1405763055000,1405763055000
sgv,176,2014-07-19T03:09:15.000-07:00,1405764555000,dexcom,Flat,5c5a2404e0196f4d3d9a7187,1405764555000,1405764555000
```
