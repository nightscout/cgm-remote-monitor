<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [Adding Virtual Assistant Support to a Plugin](#adding-virtual-assistant-support-to-a-plugin)
    - [Intent Handlers](#intent-handlers)
    - [Rollup handlers](#rollup-handlers)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

Adding Virtual Assistant Support to a Plugin
=========================================

To add virtual assistant support to a plugin, the `init` method of the plugin should return an object that contains a `virtAsst` key. Here is an example:

```javascript
iob.virtAsst = {
    intentHandlers: [{
        intent: "MetricNow"
        , metrics: ["iob"]
        , intentHandler: virtAsstIOBIntentHandler
    }]
    , rollupHandlers: [{
        rollupGroup: "Status"
        , rollupName: "current iob"
        , rollupHandler: virtAsstIOBRollupHandler
    }]
};
```

There are 2 types of handlers that you can supply: 
* Intent handler - Enables you to "teach" the virtual assistant how to respond to a user's question. 
* A rollup handler - Enables you to create a command that aggregates information from multiple plugins. This would be akin to the a "flash briefing". An example would be a status report that contains your current bg, iob, and your current basal.
 
### Intent Handlers

A plugin can expose multiple intent handlers (e.g. useful when it can supply multiple kinds of metrics). Each intent handler should be structured as follows:
+ `intent` - This is the intent this handler is built for. Right now, the templates used by both Alexa and Google Home use only the `"MetricNow"` intent (used for getting the present value of the requested metric)
+ `metrics` - An array of metric name(s) the handler will supply. e.g. "What is my `metric`" - iob, bg, cob, etc. Make sure to add the metric name and its synonyms to the list of metrics used by the virtual assistant(s).
    - **IMPORTANT NOTE:** There is no protection against overlapping metric names, so PLEASE make sure your metric name is unique! 
    - Note: Although this value *is* an array, you really should only supply one (unique) value, and then add aliases or synonyms to that value in the list of metrics for the virtual assistant. We keep this value as an array for backwards compatibility.
+ `intenthandler` - This is a callback function that receives 3 arguments:
    - `callback` Call this at the end of your function. It requires 2 arguments:
        - `title` - Title of the handler. This is the value that will be displayed on the Alexa card (for devices with a screen). The Google Home response doesn't currently display a card, so it doesn't use this value.
        - `text` - This is text that the virtual assistant should speak (and show, for devices with a screen).
    - `slots` - These are the slots (Alexa) or parameters (Google Home) that the virtual assistant detected (e.g. `pwd` as seen in the templates is a slot/parameter. `metric` is technically a slot, too).
    - `sandbox` - This is the Nightscout sandbox that allows access to various functions.

### Rollup handlers

A plugin can also expose multiple rollup handlers
+ `rollupGroup` - This is the key that is used to aggregate the responses when the intent is invoked
+ `rollupName` - This is the name of the handler. Primarily used for debugging
+ `rollupHandler` - This is a callback function that receives 3 arguments
    - `slots` - These are the values of the slots. Make sure to add these values to the appropriate custom slot 
    - `sandbox` - This is the nightscout sandbox that allows access to various functions.
    - `callback` -
        - `error` - This would be an error message
        - `response` - A simple object that expects a `results` string and a `priority` integer. Results should be the text (speech) that is added to the rollup and priority affects where in the rollup the text should be added. The lowest priority is spoken first. An example callback:
            ```javascript
            callback(null, {results: "Hello world", priority: 1});
            ```
