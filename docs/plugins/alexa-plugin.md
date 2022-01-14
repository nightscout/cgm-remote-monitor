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
    - [Do you use Authentication Roles?](#do-you-use-authentication-roles)
    - [Test your skill out with the test tool](#test-your-skill-out-with-the-test-tool)
        - [What questions can you ask it?](#what-questions-can-you-ask-it)
    - [Activate the skill on your Echo or other device](#activate-the-skill-on-your-echo-or-other-device)
  - [Updating your skill with new features](#updating-your-skill-with-new-features)
  - [Adding support for additional languages](#adding-support-for-additional-languages)
  - [Adding Alexa support to a plugin](#adding-alexa-support-to-a-plugin)

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
1. Sign in and go to the [Alexa developer portal](https://developer.amazon.com/alexa/console/ask).

### Create a new Alexa skill

1. Select "Alexa Skills Kit" in the main menu bar.
1. Click the "Start a Skill" button. This will take you to the Skills console.
1. Click the "Create Skill" button on the Skills console page.
1. Name your new skill "Nightscout" (or something else, if you like). Use English (US) as your language. Click "Next".
1. Choose a model to add to your skill. Click "Select" under "Custom" model, then click "Create skill" on the upper right.
1. Congrats! Your empty custom skill should now be created.

### Define the interaction model

Your Alexa skill's "interaction model" defines how your spoken questions get translated into requests to your Nightscout site, and how your Nightscout site's responses get translated into the audio responses that Alexa says back to you.

To get up and running with an interaction model, which will allow you to ask Alexa a few basic questions about your Nightscout site, you can copy and paste the configuration code for your language from [the list of templates](alexa-templates/).

- If you're language doesn't have a template, please consider starting with [the en-us template](alexa-templates/en-us.json), then [modifying it to work with your language](#adding-support-for-additional-languages), and [making a pull request](/CONTRIBUTING.md) or [submitting an issue](https://github.com/nightscout/cgm-remote-monitor/issues) with your translated template to share it with others.

Select "JSON Editor" in the left-hand menu on your skill's edit page (which you should be on if you followed the above instructions). Replace everything in the textbox with the code from your chosen template. Then click "Save Model" at the top. A success message should appear indicating that the model was saved.

Next you need to build your custom model. Click "Build Model" at the top of the same page. It'll take a minute to build, and then you should see another success message, "Build Successful".

You now have a custom Alexa skill that knows how to talk to a Nightscout site.

###  Point your skill at your site

Now you need to point your skill at *your* Nightscout site.

1. In the left-hand menu for your skill, there's an option called "Endpoint". Click it.
1. Under "Service Endpoint Type", select "HTTPS".
1. You only need to set up the Default Region. In the box that says "Enter URI...", put in `https://{yourdomain}/api/v1/alexa`. (So if your Nightscout site is at `mynightscoutsite.herokuapp.com`, you'll enter `https://mynightscoutsite.herokuapp.com/api/v1/alexa` in the box.)
    - If you use Authentication Roles, you'll need to add a bit to the end of your URL. See [the section](#do-you-use-authentication-roles) below.
1. In the dropdown under the previous box, select "My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority". 
1. Click the "Save Endpoints" button at the top.
1. You should see a success message pop up when the save succeeds.

### Do you use Authentication Roles? ###

If you use Authentication Roles, you will need to add a token to the end of your Nightscout URL when configuring your Endpoint.

1. In your Nightscout Admin Tools, add a new subject and give it the "readable" role.
    - If you **really** would like to be super specific, you could create a new role and set the permissions to `api:*:read`.
1. After the new subject is created, copy the "Access Token" value for the new row in your subject table (**don't** copy the link, just copy the text).
1. At the end of your Nighscout URL, add `?token={yourtoken}`, where `{yourtoken}` is the Access Token you just copied. Your new URL should look like `https://{yourdomain}/api/v1/alexa?token={yourtoken}`.

### Test your skill out with the test tool

Click on the "Test" tab on the top menu. This will take you to the page where you can test your new skill.

Enable testing for your skill (click the toggle). As indicated on this page, when testing is enabled, you can interact with the development version of your skill in the Alexa simulator and on all devices linked to your Alexa developer account. (Your skill will always be a development version. There's no need to publish it to the public.)

After you enable testing, you can also use the Alexa Simulator in the left column, to try out the skill. You can type in questions and see the text your skill would reply with. When typing your test question, only type what you would verbally say to an Alexa device after the wake word. (e.g. you would verbally say "Alexa, ask Nightscout how am I doing", so you would type only "ask Nightscout how am I doing") You can also hold the microphone icon to ask questions using your microphone, and you'll get the audio and text responses back.

##### What questions can you ask it?

See [Interacting with Virtual Assistants](interacting-with-virtual-assistants.md) for details on what you can do with Alexa.

### Activate the skill on your Echo or other device

If your device is [registered](https://developer.amazon.com/docs/devconsole/test-your-skill.html#h2_register) with your developer account, you should be able to use your skill right away. Try it by asking Alexa one of the above questions using your device.

## Updating your skill with new features

As more work is done on Nightscout, new ways to interact with Nighscout via Alexa may be made available. To be able to use these new features, you first will need to [update your Nightscout site](https://github.com/nightscout/cgm-remote-monitor#updating-my-version), and then you can follow the steps below to update your Alexa skill.

1. Make sure you've [updated your Nightscout site](https://github.com/nightscout/cgm-remote-monitor#updating-my-version) first.
1. Open [the latest skill template](alexa-templates/) in your language. You'll be copying the contents of the file later.
    - If your language doesn't include the latest features you're looking for, you're help [translating those new features](#adding-support-for-additional-languages) would be greatly appreciated!
1. Sign in to the [Alexa developer portal](https://developer.amazon.com/alexa/console/ask).
1. Open your Nightscout skill.
1. Open the "JSON Editor" in the left navigation pane.
1. Select everything in the text box (Ctrl + A on Windows, Cmd + A on Mac) and delete it.
1. Copy the contents of the updated template and paste it in the text box in the JSON Editor page.
1. Click the "Save Model" button near the top of the page, and then click the "Build Model" button.
1. Make sure to follow any directions specific to the Nightscout update. If there are any, they will be noted in the [release notes](https://github.com/nightscout/cgm-remote-monitor/releases).
1. If you gave your skill name something other than "night scout," you will need to go to the "Invocation" page in the left navigation pane and change the Skill Invocation Name back to your preferred name. Make sure to click the "Save Model" button followed by the "Build Model" button after you change the name.
1. Enjoy the new features!

## Adding support for additional languages

If the translations in Nightscout are configured correctly for the desired language code, Nightscout *should* automatically respond in that language after following the steps below.

If you add support for another language, please consider [making a pull request](/CONTRIBUTING.md) or [submitting an issue](https://github.com/nightscout/cgm-remote-monitor/issues) with your translated template to share it with others. You can export your translated template by going to the "JSON Editor" in the left navigation pane.

1. Open the Build tab of your Alexa Skill.
    - Get to your list of Alexa Skills at https://developer.amazon.com/alexa/console/ask and click on the name of the skill.
1. Click on the language drop-down box in the upper right corner of the window.
1. Click "Language settings".
1. Add your desired language.
1. Click the "Save" button.
1. Navigate to "CUSTOM" in the left navigation pane.
1. Select your new language in the language drop-down box.
1. Go to "JSON Editor" (just above "Interfaces" in the left navigation pane).
1. Remove the existing contents in the text box, and copy and paste the configuration code from a familiar language in [the list of templates](alexa-templates/).
1. Click "Save Model".
1. Click the "Add" button next to the "Slot Types" section in the left pane.
1. Click the radio button for "Use an existing slot type from Alexa's built-in library"
1. In the search box just below that option, search for "first name"
1. If your language has an option, click the "Add Slot Type" button for that option.
    - If your language doesn't have an option, you won't be able to ask Nightscout a question that includes a name.
1. For each Intent listed in the left navigation pane (e.g. "NSStatus" and "MetricNow"):
    1. Click on the Intent name.
    1. Scroll down to the "Slots" section
    1. If there's a slot with the name "pwd", change the Slot Type to the one found above.
        - If you didn't find one above, you'll have to see if another language gets close enough for you, or delete the slot.
    1. If there's a slot with the name "metric", click the "Edit Dialog" link on the right. This is where you set Alexa's questions and your answers if you happen to ask a question about metrics but don't include which metric you want to know.
        1. Set the "Alexa speech prompts" in your language, and remove the old ones.
        1. Under "User utterances", set the phrases you would say in response to the questions Alexa would pose from the previous step. MAKE SURE that your example phrases include where you would say the name of the metric. You do this by typing the left brace (`{`) and then selecting `metric` in the popup.
        1. Click on the Intent name (just to the left of "metric") to return to the previous screen.
    1. For each Sample Utterance, add an equivalent phrase in your language. If the phrase you're replacing has a `metric` slot, make sure to include that in your replacement phrase. Same goes for the `pwd` slot, unless you had to delete that slot a couple steps ago, in which case you need to modify the phrase to not use a first name, or not make a replacement phrase. After you've entered your replacement phrase, delete the phrase you're replacing.
1. Navigate to the "LIST_OF_METRICS" under the Slot Types section.
1. For each metric listed, add synonyms in your language, and delete the old synonyms.
    - What ever you do, **DO NOT** change the text in the "VALUE" column! Nightscout will be looking for these exact values. Only change the synonyms.
1. Click "Save Model" at the top, and then click on "Build Model".
1. You should be good to go! Feel free to try it out using the "Test" tab near the top of the window, or start asking your Alexa-enabled device some questions. See [Interacting with Virtual Assistants](interacting-with-virtual-assistants.md) for details on what you can do with Alexa.

## Adding Alexa support to a plugin

See [Adding Virtual Assistant Support to a Plugin](add-virtual-assistant-support-to-plugin.md)