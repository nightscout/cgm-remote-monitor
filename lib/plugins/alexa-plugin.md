**Table of Contents**
- [Nightscout/Alexa](#nightscoutalexa)
    - [Setup](#setup)
    - [Adding alexa support to a plugin](#Adding-alexa-support-to-a-plugin)
        - [Intent Handlers](#Intent-Handlers)
        - [Rollup handlers](#Rollup-handlers)

Nightscout/Alexa
======================================
##Setup

### 1) Make sure to add `alexa` to the list of plugins in your `ENABLE` setting
### 2) Sign in to https://developer.amazon.com/ and navigate to the "Alexa" tab. Select "Getting started" in "Alexa Skills Kit"
    * Click on "Add a new skill". Fill in "Nightscout" as the name and "nightscout" as the invocation name (feel free to use other names as you see fit).
    * This skill will not use the "Audio Player".
    * Click Next
### 3) Enter the following in the "Intent schema" box

```javascript
{
    "intents" : [
        {
            "intent": "NSStatus"
        },{
            "intent": "UploaderBattery"
        },{
            "intent": "PumpBattery"
        },{
            "intent": "LastLoop"
        },{
            "intent" : "MetricNow",
            "slots" : [{
                "name" : "metric",
                "type" : "LIST_OF_METRICS"
            },{
                "name" : "pwd",
                "type": "AMAZON.US_FIRST_NAME"
            }]
        }, {
            "intent": "InsulinRemaining",
            "slots" : [{
                "name" : "pwd",
                "type": "AMAZON.US_FIRST_NAME"
            }]
        }
    ]
}
```

### 4) Add a custom slot named "LIST_OF_METRICS" with the following values
```
bg
blood glucose
number
iob
insulin on board
current basal
basal
cob
carbs on board
carbohydrates on board
loop forecast
ar2 forecast
forecast
raw bg
raw blood glucose
```

### 5) Enter the following for "Sample Utterances"
```
NSStatus How am I doing
UploaderBattery How is my uploader battery
PumpBattery How is my pump battery
MetricNow What is my {metric}
MetricNow What my {metric} is
MetricNow What is {pwd} {metric}
InsulinRemaining How much insulin do I have left
InsulinRemaining How much insulin do I have remaining
InsulinRemaining How much insulin does {pwd} have left
InsulinRemaining How much insulin does {pwd} have remaining
LastLoop When was my last loop
```
### 6) Click next. Select "HTTPS" for your service endpoint. 
  * In the HTTPS URL enter the following: ``https://<your nightscout host>/api/v1/alexa``
  * Select "No" for Account Linking    * Select the appropriate certificate type. For heroku this is typically "My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority"
  * Click "Next"
  * Enable the skill if it isn't already.

### 7) You should now be able to interact with Nightscout via Alexa.


##Adding alexa support to a plugin
This document assumes some familiarity with the Alexa interface. You can find more information [here](https://developer.amazon.com/public/solutions/alexa/alexa-skills-kit/getting-started-guide).

To add alexa support to a plugin the ``init`` should return an object that contains an "alexa" key. Here is an example:

```javascript
var iob = {
    name: 'iob'
    , label: 'Insulin-on-Board'
    , pluginType: 'pill-major'
    , alexa : {
      rollupHandlers: [{
        rollupGroup: "Status"
        , rollupName: "current iob"
        , rollupHandler: alexaIOBRollupHandler
      }]
      , intentHandlers: [{
        intent: "MetricNow"
        , routableSlot: "metric"
        , slots: ["iob", "insulin on board"]
        , intentHandler: alexaIOBIntentHandler
      }]
    }
};
```
There are 2 types of handlers that you will need to supply: 
* Intent handler - enables you to "teach" Alexa how to respond to a user's question. 
* A rollup handler - enables you to create a command that aggregates information from multiple plugins. This would be akin to the Alexa "flash briefing". An example would be a status report that contains your current bg, iob, and your current basal.
 
###Intent Handlers
A plugin can expose multiple intent handlers.
+ ``intent`` - this is the intent in the "intent schema" above
+ ``routeableSlot`` - This enables routing by a slot name to the appropriate intent handler for overloaded intents e.g. "What is my <metric>" - iob, bg, cob, etc. This value should match the slot named in the "intent schema"
+ ``slots`` - These are the values of the slots. Make sure to add these values to the appropriate custom slot
+ ``intenthandler`` - this is a callback function that receives 3 arguments
    - ``callback`` Call this at the end of your function. It requires 2 arguments
        - ``title`` - Title of the handler. This is the value that will be displayed on the Alexa card
        - ``text`` - This is text that Alexa should speak.
    - ``slots`` - these are the slots that Alexa detected
    - ``sandbox`` - This is the nightscout sandbox that allows access to various functions.
###Rollup handlers
A plugin can also expose multiple rollup handlers
+ ``rollupGroup`` - This is the key that is used to aggregate the responses when the intent is invoked
+ ``rollupName`` - This is the name of the handler. Primarily used for debugging
+ ``rollupHandler`` - this is a callback function that receives 3 arguments
    - ``slots`` - These are the values of the slots. Make sure to add these values to the appropriate custom slot 
    - ``sandbox`` - This is the nightscout sandbox that allows access to various functions.
    - ``callback`` -
        - ``error`` - This would be an error message
        - ``response`` - A simple object that expects a ``results`` string and a ``priority`` integer. Results should be the text (speech) that is added to the rollup and priority affects where in the rollup the text should be added. The lowest priority is spoken first. An example callback:
            ```javascript
            callback(null, {results: "Hello world", priority: 1});
            ```
