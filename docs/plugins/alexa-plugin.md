<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [Nightscout Alexa Plugin](#nightscout-alexa-plugin)
  - [Overview](#overview)
  - [Activate the Nightscout Alexa Plugin](#activate-the-nightscout-alexa-plugin)
  - [Create Your Alexa Skill](#create-your-alexa-skill)
    - [Get an Amazon Developer account](#get-an-amazon-developer-account)
    - [Create a new Alexa skill](#create-a-new-alexa-skill)
    - [Define the interaction model](#define-the-interaction-model)
    - [Point your skill at your site](#point-your-skill-at-your-site)
    - [Test your skill out with the test tool](#test-your-skill-out-with-the-test-tool)
        - [What questions can you ask it?](#what-questions-can-you-ask-it)
    - [Activate the skill on your Echo or other device](#activate-the-skill-on-your-echo-or-other-device)
  - [Adding Alexa support to a plugin](#adding-alexa-support-to-a-plugin)
    - [Intent Handlers](#intent-handlers)
    - [Rollup handlers](#rollup-handlers)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

Nightscout Alexa Plugin
======================================

## Overview

To add Alexa support for your Nightscout site, here's what you need to do:

1. [Activate the `alexa` plugin](#activate-the-nightscout-alexa-plugin) on your Nightscout site, so your site will respond correctly to Alexa's requests.
1. [Create a custom Alexa skill](#create-your-alexa-skill) that points at your site and defines certain questions you want to be able to ask. (You'll copy and paste a basic template for this, to keep things simple.)

To add Alexa support for a plugin, [check this out](#adding-alexa-support-to-a-plugin).

## Activate the Nightscout Alexa Plugin 

1. Your Nightscout site needs to be new enough that it supports the `alexa` plugin. It needs to be [version 0.9.1 (Grilled Cheese)](https://github.com/nightscout/cgm-remote-monitor/releases/tag/0.9.1) or later. See [updating my version](https://github.com/nightscout/cgm-remote-monitor#updating-my-version) if you need a newer version.
1. Add `alexa` to the list of plugins in your `ENABLE` setting. ([Environment variables](https://github.com/nightscout/cgm-remote-monitor#environment) are set in the configuration section for your monitor. Typically Azure, Heroku, etc.)
1. The Alexa plugin pulls its units preferences from your site's defaults. If you don't have a `DISPLAY_UNITS` entry, it will default to `mg/dl`. If you want it to use mmol/L, make sure you have a `DISPLAY_UNITS` line, and set it to `mmol` (*not* `mmol/l`).

## Create Your Alexa Skill

### Get an Amazon Developer account

1. Sign up for a free [Amazon Developer account](https://developer.amazon.com/) if you don't already have one.
1. [Register](https://developer.amazon.com/docs/devconsole/test-your-skill.html#h2_register) your Alexa-enabled device with your Developer account.
1. Sign in and go to the [Alexa developer portal](https://developer.amazon.com/alexa). 

### Create a new Alexa skill

1. Select "Alexa Skills Kit" in the main menu bar.
1. Click the "Start a Skill" button. This will take you to the Skills console.
1. Click the "Create Skill" button on the Skills console page.
1. Name your new skill "Nightscout" (or something else, if you like). Use English (US) as your language. Click "Next".
1. Choose a model to add to your skill. Click "Select" under "Custom" model, then click "Create skill" on the upper right.
1. Congrats! Your empty custom skill should now be created.

### Define the interaction model

Your Alexa skill's "interaction model" defines how your spoken questions get translated into requests to your Nightscout site, and how your Nightscout site's responses get translated into the audio responses that Alexa says back to you.

To get up and running with a basic interaction model, which will allow you to ask Alexa a few basic questions about your Nightscout site, you can copy and paste the configuration code below.

```json
{
    "interactionModel": {
        "languageModel": {
            "invocationName": "nightscout",
            "intents": [
                {
                    "name": "NSStatus",
                    "slots": [],
                    "samples": [
                        "How am I doing"
                    ]
                },
                {
                    "name": "UploaderBattery",
                    "slots": [],
                    "samples": [
                        "How is my uploader battery"
                    ]
                },
                {
                    "name": "PumpBattery",
                    "slots": [],
                    "samples": [
                        "How is my pump battery"
                    ]
                },
                {
                    "name": "LastLoop",
                    "slots": [],
                    "samples": [
                        "When was my last loop"
                    ]
                },
                {
                    "name": "MetricNow",
                    "slots": [
                        {
                            "name": "metric",
                            "type": "LIST_OF_METRICS"
                        },
                        {
                            "name": "pwd",
                            "type": "AMAZON.US_FIRST_NAME"
                        }
                    ],
                    "samples": [
                        "What is my {metric}",
                        "What my {metric} is",
                        "What is {pwd} {metric}"
                    ]
                },
                {
                    "name": "InsulinRemaining",
                    "slots": [
                        {
                            "name": "pwd",
                            "type": "AMAZON.US_FIRST_NAME"
                        }
                    ],
                    "samples": [
                        "How much insulin do I have left",
                        "How much insulin do I have remaining",
                        "How much insulin does {pwd} have left",
                        "How much insulin does {pwd} have remaining"
                    ]
                }
            ],
            "types": [
                {
                    "name": "LIST_OF_METRICS",
                    "values": [
                        {
                            "name": {
                                "value": "bg"
                            }
                        },
                        {
                            "name": {
                                "value": "blood glucose"
                            }
                        },
                        {
                            "name": {
                                "value": "number"
                            }
                        },
                        {
                            "name": {
                                "value": "iob"
                            }
                        },
                        {
                            "name": {
                                "value": "insulin on board"
                            }
                        },
                        {
                            "name": {
                                "value": "current basal"
                            }
                        },
                        {
                            "name": {
                                "value": "basal"
                            }
                        },
                        {
                            "name": {
                                "value": "cob"
                            }
                        },
                        {
                            "name": {
                                "value": "carbs on board"
                            }
                        },
                        {
                            "name": {
                                "value": "carbohydrates on board"
                            }
                        },
                        {
                            "name": {
                                "value": "loop forecast"
                            }
                        },
                        {
                            "name": {
                                "value": "ar2 forecast"
                            }
                        },
                        {
                            "name": {
                                "value": "forecast"
                            }
                        },
                        {
                            "name": {
                                "value": "raw bg"
                            }
                        },
                        {
                            "name": {
                                "value": "raw blood glucose"
                            }
                        }
                    ]
                }
            ]
        }
    }
}
```

Select "JSON Editor" in the left-hand menu on your skill's edit page (which you should be on if you followed the above instructions). Replace everything in the textbox with the above code. Then click "Save Model" at the top. A success message should appear indicating that the model was saved.

Next you need to build your custom model. Click "Build Model" at the top of the same page. It'll take a minute to build, and then you should see another success message, "Build Successful".

You now have a custom Alexa skill that knows how to talk to a Nightscout site.

###  Point your skill at your site

Now you need to point your skill at *your* Nightscout site.

1. In the left-hand menu for your skill, there's an option called "Endpoint". Click it.
1. Under "Service Endpoint Type", select "HTTPS".
1. You only need to set up the Default Region. In the box that says "Enter URI...", put in `https://{yourdomain}/api/v1/alexa`. (So if your Nightscout site is at `mynightscoutsite.herokuapp.com`, you'll enter `https://mynightscoutsite.herokuapp.com/api/v1/alexa` in the box.)
1. In the dropdown under the previous box, select "My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority". 
1. Click the "Save Endpoints" button at the top.
1. You should see a success message pop up when the save succeeds.

### Test your skill out with the test tool

Click on the "Test" tab on the top menu. This will take you to the page where you can test your new skill.

Enable testing for your skill (click the toggle). As indicated on this page, when testing is enabled, you can interact with the development version of your skill in the Alexa simulator and on all devices linked to your Alexa developer account. (Your skill will always be a development version. There's no need to publish it to the public.)

After you enable testing, you can also use the Alexa Simulator in the left column, to try out the skill. You can type in questions and see the text your skill would reply with. You can also hold the microphone icon to ask questions using your microphone, and you'll get the audio and text responses back.

##### What questions can you ask it?

*Forecast:*

- "Alexa, ask Nightscout how am I doing"
- "Alexa, ask Nightscout how I'm doing"

*Uploader Battery:*

- "Alexa, ask Nightscout how is my uploader battery"

*Pump Battery:*

- "Alexa, ask Nightscout how is my pump battery"

*Metrics:*

- "Alexa, ask Nightscout what my bg is"
- "Alexa, ask Nightscout what my blood glucose is"
- "Alexa, ask Nightscout what my number is"
- "Alexa, ask Nightscout what is my insulin on board"
- "Alexa, ask Nightscout what is my basal"
- "Alexa, ask Nightscout what is my current basal"
- "Alexa, ask Nightscout what is my cob"
- "Alexa, ask Nightscout what is Charlie's carbs on board"
- "Alexa, ask Nightscout what is Sophie's carbohydrates on board"
- "Alexa, ask Nightscout what is Harper's loop forecast"
- "Alexa, ask Nightscout what is Alicia's ar2 forecast"
- "Alexa, ask Nightscout what is Peter's forecast"
- "Alexa, ask Nightscout what is Arden's raw bg"
- "Alexa, ask Nightscout what is Dana's raw blood glucose"

*Insulin Remaining:*

- "Alexa, ask Nightscout how much insulin do I have left"
- "Alexa, ask Nightscout how much insulin do I have remaining"
- "Alexa, ask Nightscout how much insulin does Dana have left?
- "Alexa, ask Nightscout how much insulin does Arden have remaining?

*Last Loop:*

- "Alexa, ask Nightscout when was my last loop"

(Note: all the formats with specific names will respond to questions for any first name. You don't need to configure anything with your PWD's name.)

### Activate the skill on your Echo or other device

If your device is [registered](https://developer.amazon.com/docs/devconsole/test-your-skill.html#h2_register) with your developer account, you should be able to use your skill right away. Try it by asking Alexa one of the above questions using your device.

## Adding Alexa support to a plugin

See [Adding Virtual Assistant Support to a Plugin](add-virtual-assistant-support-to-plugin.md)