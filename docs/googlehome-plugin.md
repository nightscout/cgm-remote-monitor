Nightscout GoogleHome - DialogFlow Plugin
======================================

## Overview

To add GoogleHome support for your Nightscout site, here's what you need to do:

1. Activate the `googlehome` plugin on your Nightscout site, so your site will respond correctly to Google's requests.
2. Create a custom DialogFlow agent that points at your site and defines certain questions you want to be able to ask. (You'll copy and paste a basic template for this, to keep things simple.)
3. Create desired integrations with DialogFlow


## Activate the Nightscout GoogleHome Plugin 

1. Your Nightscout site needs to be new enough that it supports the `googlehome` plugin. .
2. Add `googlehome` to the list of plugins in your `ENABLE` setting. ([Environment variables](https://github.com/nightscout/cgm-remote-monitor#environment) are set in the configuration section for your monitor. Typically Azure, Heroku, etc.)

## Create Your DialogFlow Agent

### Signin to DialogFlow

- Sign in to DialogFlow with your Google account (https://console.dialogflow.com/api-client/#/login). If you don't already have one, signup with Google.

### Create a new custom DialogFlow agent

1. Select "Create new agent" in the main menu bar.
2. Input a custom name for your agent and click "CREATE".
3. Download the simple agent template : ( https://drive.google.com/drive/folders/18z2kQSEInvH4O_jfjB4Qh8z9508P9Oao?usp=sharing )
4. Select IMPORT FROM ZIP , in order to import the template. 
5. SAVE
6. Go to "Fullfillment" menu and enter details about your webhook. 
7. SAVE
8. Go to "Integration" menu and select your desired integration.
9. Follow instructions for each desired integration. 
