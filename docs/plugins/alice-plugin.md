<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

Nightscout Yandex.Alice Plugin
======================================

## Overview

This plugin will allow you to receive data from the Nightscout using any services and devices that support Yandex.Alice:

- Yandex.Station.
- Yandex.Auto.
- Yandex.Navi.
- Yandex application for iOS and Android.
- Yandex.Browser.
- Alice for Windows.

Just say "Alice, ask Nightscout how much sugar" (or other question) and receive answer.

### How to use plugin

To add Alice support for your Nightscout site, here's what you need to do:

1. [Activate the `alice` plugin](#activate-the-nightscout-alice-plugin) on your Nightscout site, so your site will respond correctly to Alice's requests.
1. [Create a custom Alice skill](#create-your-alice-skill) that points at your site and defines certain questions you want to be able to ask. (You'll copy and paste a basic template for this, to keep things simple.)

To add Alice support for a plugin, [check this out](#adding-alice-support-to-a-plugin).

## Activate the Nightscout Alice Plugin 

1. Your Nightscout site needs to be new enough that it supports the `alice` plugin. It needs to be [version 14.2.6](https://github.com/nightscout/cgm-remote-monitor/releases/tag/14.2.6) or later. See [updating my version](https://github.com/nightscout/cgm-remote-monitor#updating-my-version) if you need a newer version.
1. Add `alice` to the list of plugins in your `ENABLE` setting. ([Environment variables](https://github.com/nightscout/cgm-remote-monitor#environment) are set in the configuration section for your monitor. Typically Azure, Heroku, etc.)
1. The Alice plugin pulls its units preferences from your site's defaults. If you don't have a `DISPLAY_UNITS` entry, it will default to `mg/dl`. If you want it to use mmol/L, make sure you have a `DISPLAY_UNITS` line, and set it to `mmol` (*not* `mmol/l`).
1. Restart Nightscout. 

## Create Your Alice Skill

### Get an Yandex account

1. Sign up for a free [Yandex account](https://passport.yandex.ru/registration?mode=register) if you don't already have one.
1. [Register](https://yandex.ru/support/station/start/turn-on.html) your Yandex station (or other device with Alice voice assistant).

### Create a new Alice skill

1. Open [Yandex.Dialogs](https://dialogs.yandex.ru/developer) in your browser.
1. Select "Create dialog" in the main screen.
1. Select "Alice's skill" (type of new dialog).
1. Congrats! Your empty custom skill should now be created.

### Set up the assistant's skill

1. Open the "Settings" tab.
1. Open the "Main settings" tab.
1. Fill in the form fields:

	+ Skill name - Any that you want, "Nightscout", "Nightscout connector", "Sugar viewver" or any other. Skill name must be unique for Alice skills from all users! 
	+ Activation phrases - any simple phrase, such as "Sugar", "Libre", "Monitor" or other.
	
	> Alice is poor at recognizing queries in languages ​​other than Russian. For this reason, pay attention to the following note:
	>
	> If you will be making queries in English, the "Skill name" and "Activation phrases" fields must consist of two or more words (these are Yandex restrictions).
	>
	> If you will be making queries in Russian, then use the most simple and understandable words as activation phrases, such as "Найт", "Либра", "Сайт", etc. Otherwise, requests such as "Алиса, спроси у Найтскаут ..." require you to pronounce the sounds clearly and pause so that recognition occurs without errors.	 
	
	 + Backend - `https://{yourdomain}/api/v1/alice`. So if your Nightscout site is at `mynightscoutsite.herokuapp.com`, you'll enter `https://mynightscoutsite.herokuapp.com/api/v1/alice` in the field.
	 + Access type - "Private".
	 + Enter any values in the Publication in the catalog section.

	 > In the process of filling, pay attention to the auxiliary text
1. Click the "Save" button.

### Define the interaction model

1. Open the "Intents" tab.
1. Click the "Enter" button.
1. Click on the new field (with text "Untitled").
1. Fill in the form fields:

	+ Title - "Alice".
	+ ID - "alice".
	
	> Important! ID must be 'alice', not 'alisa' or others.
	
	+ Grammar - copy from [the template](alice-templates/ru-ru/intent.txt)
	+ Click the "Save" button.
	+ Close current popover window.

1. Click the "Edit" button in Entities section.
1. Copy content from [the template](alice-templates/ru-ru/entities.txt) to current popover window.

	> If necessary, you can make changes to the interaction model, adding the ability to request new parameters. But this requires a certain level of skills.

1. Congrats! Your interaction model should now be created.
1. Click the "Deploy" button and wait. It will take 5-30 minutes.

### Activate the skill on your Yandex.Station or other device

1. After you skill be published open the "Access" tab.
1. Generate and open link in you browser.
1. Select "Run the skill on the station".

### Create scenario for simple using skill

This is not a required step, but it will make it easier for you to communicate with the Nightscout.

1. Open Yandex app (or Yandex Smart Home app).
2. Create new scenario in your Home.
3. Set scenario name.
4. Add start condition: any simple phrase, such "How much sugar".
5. Add action: Station must answer on question "Ask %Skillname% sugar". %Skillname% must be replaced with the name of your own Alice skill.

## Interaction with skill

> Now the plugin can have support of English language. All quieries at this section will show on russian.

At the moment, you can request information about the following parameters:

- blood glucose
- active insulin
- delta
- general status (different information in one request)
- pump battery charge
- the remainder of insulin in the reservoir

All requests must begin with the words

- [EN] **Alice, ask %activation phrase%**
- [RU] **Алиса, узнай у %активацонная фраза%**
- [RU] **Алиса, спроси у %активацонная фраза%**

Further, the required parameters are indicated in any form.

 - [RU] Алиса, спроси у Найт мой сахар
 - [RU] Алиса, спроси у Найт уровень сахара
 - [RU] Алиса, спроси у Найт глюкозу
 - [RU] Алиса, спроси у Найт мой уровень глюкозы крови
 - [RU] ... активный инсулин
 - [RU] ... уровень инсулина
 - [RU] ... дельту
 - [RU] ... статус
 - [RU] ... заряд
 - [RU] ... заряд батареи
 - [RU] ... запас резервуара
 - [RU] ... запас помпы

## Why plugin doesn't work

This can happen for several reasons.

+ Restart Nightscout.
+ You have installed a old version (or another git branch) of Nightscout that does not have a plugin.
+ You entered an invalid intent ID in Yandex.dialog settings. Make sure it is listed "alice" and not "alisa" or others.
+ Be sure, that your Alice skill (include intents) was published.

## Adding Alice support to a plugin

See [Adding Virtual Assistant Support to a Plugin](add-virtual-assistant-support-to-plugin.md)