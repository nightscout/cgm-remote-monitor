<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [Nightscout Google Home/DialogFlow Plugin](#nightscout-google-homedialogflow-plugin)
  - [Overview](#overview)
  - [Activate the Nightscout Google Home Plugin](#activate-the-nightscout-google-home-plugin)
  - [Create Your DialogFlow Agent](#create-your-dialogflow-agent)
    - [What questions can you ask it?](#what-questions-can-you-ask-it)
  - [Updating your agent with new features](#updating-your-agent-with-new-features)
  - [Adding support for additional languages](#adding-support-for-additional-languages)
  - [Adding Google Home support to a plugin](#adding-google-home-support-to-a-plugin)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

Nightscout Google Home/DialogFlow Plugin
========================================

## Overview

To add Google Home support for your Nightscout site, here's what you need to do:

1. [Activate the `googlehome` plugin](#activate-the-nightscout-google-home-plugin) on your Nightscout site, so your site will respond correctly to Google's requests.
1. [Create a custom DialogFlow agent](#create-your-dialogflow-agent) that points at your site and defines certain questions you want to be able to ask.

## Activate the Nightscout Google Home Plugin

1. Your Nightscout site needs to be new enough that it supports the `googlehome` plugin. It needs to be [version 13.0.0 (Ketchup)](https://github.com/nightscout/cgm-remote-monitor/releases/tag/13.0.0) or later. See [updating my version](https://github.com/nightscout/cgm-remote-monitor#updating-my-version) if you need a newer version.
1. Add `googlehome` to the list of plugins in your `ENABLE` setting. ([Environment variables](https://github.com/nightscout/cgm-remote-monitor#environment) are set in the configuration section for your monitor. Typically Azure, Heroku, etc.)

## Create Your DialogFlow Agent

1. Download the agent template in your language for Google Home [here](google-home-templates/).
    - If you're language doesn't have a template, please consider starting with [the en-us template](google-home-templates/en-us.zip), then [modifying it to work with your language](#adding-support-for-additional-languages), and [making a pull request](/CONTRIBUTING.md) or [submitting an issue](https://github.com/nightscout/cgm-remote-monitor/issues) with your translated template to share it with others.
1. [Sign in to Google's Action Console](https://console.actions.google.com)
    - Make sure to use the same account that is connected to your Google Home device, Android smartphone, Android tablet, etc.
1. Click on the "New Project" button.
1. If prompted, agree to the Terms of Service.
1. Give your project a name (e.g. "Nightscout") and then click "Create project".
1. For the "development experience", select "Conversational" at the bottom of the list.
1. Click on the "Develop" tab at the top of the sreen.
1. Click on "Invocation" in the left navigation pane.
1. Set the display name (e.g. "Night Scout") of your Action and set your Google Assistant voice.
    - Unfortunately, the Action name needs to be two words, and is required to be unique across all of Google, even though you won't be publishing this for everyone on Google to use. So you'll have to be creative with the name since "Night Scout" is already taken.
1. Click "Save" in the upper right corner.
1. Navigate to "Actions" in the left nagivation pane, then click on the "Add your first action" button.
1. Make sure you're on "Cutom intent" and then click "Build" to open DialogFlow in a new tab.
1. Sign in with the same Google account you used to sign in to the Actions Console.
    - You'll have to go through the account setup steps if this is your first time using DialogFlow.
1. Verify the name for your agent (e.g. "Nightscout") and click "CREATE".
1. In the navigation pane on the left, click the gear icon next to your agent name.
1. Click on the "Export and Import" tab in the main area of the page.
1. Click the "IMPORT FROM ZIP" button.
1. Select the template file downloaded in step 1.
1. Type "IMPORT" where requested and then click the "IMPORT" button.
1. After the import finishes, click the "DONE" button followed by the "SAVE" button.
1. In the navigation pane on the left, click on "Fulfillment".
1. Enable the toggle for "Webhook" and then fill in the URL field with your Nightscout URL: `https://YOUR-NIGHTSCOUT-SITE/api/v1/googlehome`
1. Scroll down to the bottom of the page and click the "SAVE" button.
1. Click on "Integrations" in the navigation pane.
1. Click on "INTEGRATION SETTINGS" for "Google Assistant".
1. Under "Implicit invocation", add every intent listed.
1. Turn on the toggle for "Auto-preview changes".
1. Click "CLOSE".

That's it! Now try asking Google "Hey Google, ask *your Action's name* how am I doing?"

### What questions can you ask it?

See [Interacting with Virtual Assistants](interacting-with-virtual-assistants.md) for details on what you can do with Google Home.

## Updating your agent with new features

As more work is done on Nightscout, new ways to interact with Nighscout via Google Home may be made available. To be able to use these new features, you first will need to [update your Nightscout site](https://github.com/nightscout/cgm-remote-monitor#updating-my-version), and then you can follow the steps below to update your DialogFlow agent.

1. Make sure you've [updated your Nightscout site](https://github.com/nightscout/cgm-remote-monitor#updating-my-version) first.
1. Download [the latest skill template](google-home-templates/) in your language.
    - If your language doesn't include the latest features you're looking for, you're help [translating those new features](#adding-support-for-additional-languages) would be greatly appreciated!
1. Sign in to the [DialogFlow developer portal](https://dialogflow.cloud.google.com/).
1. Make sure you're viewing your Nightscout agent (there's a drop-down box immediately below the DialogFlow logo where you can select your agent).
1. Click on the gear icon next to your agent name, then click on the "Export and Import" tab.
1. Click the "RESTORE FROM ZIP" button.
1. Select the template file you downloaded earlier, then type "RESTORE" in the text box as requested, and click the "RESTORE" button.
1. After the import is completed, click the "DONE" button.
1. Make sure to follow any directions specific to the Nightscout update. If there are any, they will be noted in the [release notes](https://github.com/nightscout/cgm-remote-monitor/releases).
1. Enjoy the new features!

## Adding support for additional languages

If the translations in Nightscout are configured correctly for the desired language code, Nightscout *should* automatically respond in that language after following the steps below.

If you add support for another language, please consider [making a pull request](/CONTRIBUTING.md) or [submitting an issue](https://github.com/nightscout/cgm-remote-monitor/issues) with your translated template to share it with others. You can export your translated template by going to the settings of your DialogFlow agent (the gear icon next to the project's name in the left nagivation pane), going to the "Export and Import" tab, and clicking "EXPORT AS ZIP".

1. Open your DialogFlow agent.
    - Get to your list of agents at https://console.dialogflow.com/api-client/#/agents and click on the name of your Nightscout agent.
1. Click on the "Languages" tab.
1. Click the "Add Additional Language" drop-down box.
1. Select your desired language.
1. Click the "SAVE" button.
    - Note the new language code below the agent's name. e.g. if you're using the English template and you added Spanish, you would see two buttons: "en" and "es".
1. Click on "Intents" in the left navigation pane.
1. For each intent in the list (NOT including those that start with "Default" in the name):
    1. Click on the intent name.
    1. Note the phrases used in the "Training phrases" section.
        - If the phrase has a colored block (e.g. `metric` or `pwd`), click the phrase (but NOT the colored block) and note the "PARAMETER NAME" of the item with the same-colored "ENTITY".
    1. Click on the new language code (beneath the agent name near the top of the navigation pane).
    1. Add equivalent or similar training phrases as those you noted a couple steps ago.
        - If the phrase in the orginal language has a colored block with a word in it, that needs to be included. When adding the phrase to the new language, follow these steps to add the colored block:
            1. When typing that part of the training phrase, don't translate the word in the block; just keep it as-is.
            1. After typing the phrase (DON'T push the Enter key yet!) highlight/select the word.
            1. A box will pop up with a list of parameter types, some of which end with a colon (`:`) and a parameter name. Click the option that has the same parameter name as the one you determined just a few steps ago.
            1. Press the Enter key to add the phrase.
    1. Click the "SAVE" button.
    1. Go back and forth between your starting language and your new language, adding equivalent phrase(s) to the new language. Continue once you've added all the equivalent phrases you can think of.
    1. Scroll down to the "Action and parameters" section.
    1. If any of the items in that list have the "REQUIRED" option checked:
        1. Click the "Define prompts..." link on the right side of that item.
        1. Add phrases that Google will ask if you happen to say something similar to a training phrase, but don't include this parameter (e.g. if you ask about a metric but don't say what metric you want to know about).
        1. Click "CLOSE".
    1. Scroll down to the "Responses" section.
    1. Set just one phrase here. This will be what Google says if it has technical difficulties getting a response from your Nightscout website.
    1. Click the "SAVE" button at the top of the window.
1. Click on the "Entities" section in the navigation pane.
1. For each entity listed:
    1. Click the entity name.
    1. Switch to the starting language (beneath the agent name near the top of the left navigation pane).
    1. Click the menu icon to the right of the "SAVE" button and click "Switch to raw mode".
    1. Select all the text in the text box and copy it.
    1. Switch back to your new language.
    1. Click the menu icon to the right of the "SAVE" button and click "Switch to raw mode".
    1. In the text box, paste the text you just copied.
    1. Click the menu icon to the right of the "SAVE" button and click "Switch to editor mode".
    1. For each item in the list, replace the items on the RIGHT side of the list with equivalent words and phrases in your language.
        - What ever you do, **DO NOT** change the values on the left side of the list. Nightscout will be looking for these exact values. Only change the items on the right side of the list.
    1. Click the "SAVE" button.
1. You should be good to go! Feel free to try it out by click the "See how it works in Google Assistant" link in the right navigation pane, or start asking your Google-Home-enabled device some questions. See [Interacting with Virtual Assistants](interacting-with-virtual-assistants.md) for details on what you can do with Google Home.

## Adding Google Home support to a plugin

See [Adding Virtual Assistant Support to a Plugin](add-virtual-assistant-support-to-plugin.md)