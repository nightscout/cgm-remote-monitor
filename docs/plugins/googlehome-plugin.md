Nightscout Google Home/DialogFlow Plugin
========================================

## Overview

To add Google Home support for your Nightscout site, here's what you need to do:

1. [Activate the `googlehome` plugin](#activate-the-nightscout-google-home-plugin) on your Nightscout site, so your site will respond correctly to Google's requests.
1. [Create a custom DialogFlow agent](#create-your-dialogflow-agent) that points at your site and defines certain questions you want to be able to ask.

## Activate the Nightscout Google Home Plugin

1. Your Nightscout site needs to be new enough that it supports the `googlehome` plugin. It needs to be [version VERSION_NUMBER (VERSION_NAME)](https://github.com/nightscout/cgm-remote-monitor/releases/tag/VERSION_NUMBER) or later. See [updating my version](https://github.com/nightscout/cgm-remote-monitor#updating-my-version) if you need a newer version.
1. Add `googlehome` to the list of plugins in your `ENABLE` setting. ([Environment variables](https://github.com/nightscout/cgm-remote-monitor#environment) are set in the configuration section for your monitor. Typically Azure, Heroku, etc.)

## Create Your DialogFlow Agent

1. Download the [Google Home Nightscout agent template](googlehome-nightscout-template.zip).
1. [Sign in to Google's Action Console](https://console.actions.google.com)
1. Click on the "New Project" button.
1. If prompted, agree to the Terms of Service.
1. Give your project a name (e.g. "Nightscout") and then click "Create project".
1. Click any of the "development experience" options (it really doesn't matter).
1. Click on the "Develop" tab at the top of the sreen
1. Click on "Invocation" in the left navigation pane.
1. Set the display name (e.g. "Nightscout") and set your Google Assistant voice.
    - Unfortunately, the name needs to be two words, and has to be unique across all of Google, even though you won't be publishing for everyone on Google to use. So you'll have to be creative in the name since "Night Scout" is already taken.
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

## Adding Google Home support to a plugin

See [Adding Virtual Assistant Support to a Plugin](add-virtual-assistant-support-to-plugin.md)