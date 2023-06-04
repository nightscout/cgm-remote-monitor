<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [Interacting with Virtual Assistants](#interacting-with-virtual-assistants)
- [Alexa vs. Google Home](#alexa-vs-google-home)
- [What questions can you ask it?](#what-questions-can-you-ask-it)
  - [General Status](#general-status)
  - [Last Loop](#last-loop)
  - [Specific Info](#specific-info)
    - [No plugin](#no-plugin)
    - [`bgnow`*](#bgnow)
    - [`xdripjs`](#xdripjs)
    - [`dbsize`*](#dbsize)
    - [`upbat`*](#upbat)
    - [`pump`](#pump)
    - [`iob`](#iob)
    - [`basal`*](#basal)
    - [`cob`](#cob)
    - [`ar2`, or `loop`, or `openaps`](#ar2-or-loop-or-openaps)
    - [`rawbg`](#rawbg)
  - [Entering Treatments](#entering-treatments)
    - [`careportal`*](#careportal)
    - [`openaps`](#openaps)
  - [A note about names](#a-note-about-names)
  - [The techy way to know what you can ask](#the-techy-way-to-know-what-you-can-ask)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

Interacting with Virtual Assistants
===================================

# Alexa vs. Google Home

Although these example phrases reference Alexa, the exact same questions could be asked of Google.
Just replace "Alexa, ask Nightscout ..." with "Hey Google, ask *your action's name* ..."

# What questions can you ask it?

This list should include everything you can ask your virtual assistant. (disclaimer: sometimes we forget to update the list when things change)

## General Status

- "Alexa, ask Nightscout how am I doing"
- "Alexa, ask Nightscout how I'm doing"

## Last Loop

Requires the [`loop`](/README.md#loop-loop) plugin.

- "Alexa, ask Nightscout when was my last loop"

## Specific Info

Say "Alexa, ask Nightscout what is *{thing}*", where "*{thing}*" is the piece of info from below that you would like to know. You can also ask in these ways, depending on what sounds best to you for your question:

- "ask Nightscout what's my *{thing}*"
- "ask Nightscout what my *{thing}* is"
- "ask Nightscout how much *{thing}* I have left"
- "ask Nightscout how is my *{thing}*"
- "ask Nightscout what is Charlie's *{thing}*"
- "ask Nightscout how much does Dana have left of *{thing}*"

**Note:** you're not restricted to only these ways of asking these questions; virtual assistants usually do pretty well in allowing you flexibility in the exact way you phrase things.

Most info comes from other Nightscout plugins, which means that plugin needs to be enabled for your virtual assistant to be able to answer your question. There are several plugins that come enabled by default in Nightscout. These plugins have been marked with asterisks (*).

**Note:** There are a few different ways to name the same piece of info. We try to list a few different examples for each one here, but sometimes you can say it a different way that also works.

### No plugin

- bg, blood sugar, blood glucose, number

### `bgnow`*

- blood glucose delta, blood sugar delta, bg delta, delta

### [`xdripjs`](/README.md#xdripjs-xdrip-js)

- cgm battery, cgm battery levels, transmitter batteries
- cgm transmitter age, transmitter age
- cgm session age, session age
- cgm status
- cgm noise
- cgm mode

### `dbsize`*

- database size, db size, file size

### [`upbat`](/README.md#upbat-uploader-battery)*

- uploader battery, uploader battery power

### [`pump`](/README.md#pump-pump-monitoring)

- pump reservoir, insulin remaining, insulin in my pump
- pump battery, pump battery power

### [`iob`](/README.md#iob-insulin-on-board)

- iob, insulin on board

### [`basal`](/README.md#basal-basal-profile)*

- basal, current basal

### [`cob`](/README.md#cob-carbs-on-board)

- cob, carbs on board, carbohydrates on board

### [`ar2`](/README.md#ar2-ar2-forecasting), or [`loop`](/README.md#loop-loop), or [`openaps`](/README.md#openaps-openaps)

- forecast, ar2 forecast, loop forecast

### [`rawbg`](/README.md#rawbg-raw-bg)

- raw bg, raw number, raw blood sugar

## Entering Treatments

Yes! You can enter treatment information using your virtual assistant! This requires Nightscout version (TODO: enter a version number here when the release is determined) or higher. All treatment info is entered using Nightscout plugins, which means that the respective plugin needs to be enabled for your virtual assistant to be able to enter treatments. Plugins that are enabled by default have been marked with asterisks (*).

Because each treatment type has its own set of information to collect, we'll list each one and include some examples of other ways to say the same thing. All of these examples start with "Alexa, tell Nightscout ...", "Alexa, tell Nightscout that ...", "Alexa, tell Nightscout to ...", etc.

**Note 1:** The examples of what to say for each treatment is not comprehensive; virtual assistants usually do pretty well in allowing you flexibility in the exact way you phrase things.

**Note 2:** Virtual assistants usually do pretty well about handling whatever time you would like to say; you're not limited to just one number and one unit (e.g. 30 minutes). You can say things like "2 hours and 17 minutes" or even "137 minutes".

**Note 3:** When saying a specific time of day (e.g. "4 pm"), it's best if you also say what day that time is on (e.g. "4 pm today" or "yesterday at 4 pm"), otherwise your virtual assistant may always assume the time is in the future (or in the past, depending on which assistant you use).

**Note 4:** When you tell your virtual assistant a blood glucose value, it interprets that value based on your glucose unit set in Nightscout. So if your Nightscout site is set to mmo/l, saying a glucose value of 100 will be interpreted as 100 mmo/l (not 100 mg/dl!).

### [`careportal`](/README.md#careportal-careportal)*

A few of these have been inspired by OpenAPS (marked with a double asterisk - **), but they do not require the `openaps` plugin.

- I'm eating carbohydrates
  - I'm eating 15 carbs
  - I ate 45 carbs 20 minutes ago
  - I ate 23 carbs at 4 pm today
  - I'll be eating 72 carbs in 45 minutes
  - I'll be eating 50 carbs at 8:30 am today
- I tested my blood sugar
  - I tested at 134
  - My glucose was 6.5 at 1 pm today
  - I tested my bg at 235 15 minutes ago
- Enable activity mode **
  - Turn on activity mode for 40 minutes
  - Enable activity mode in an hour and a half for 2 hours
  - Turn on activity mode at 4:40 pm today
- I'll be eating soon **
  - I will be eating shortly
  - I'm eating pretty soon
- I changed my infusion set
  - I changed my inset
  - I changed my site at 11 am today
  - I changed my pump site 25 minutes ago
- I changed my pump battery
  - I changed my battery
  - I change my pump battery at 10 am today
- I changed my pump cartridge
  - I changed my insulin today at 5 pm
  - I changed my cartridge
- Setup a temporary target
  - Create a temp target at 120
  - Enable a temporary target at 150 for 45 minutes
  - Set a temp target at 2 o'clock today from 6.7 to 8.3
- Cancel my temporary target
  - Stop the temp target
  - Cancel the temporary target at 3:30 am tomorrow
  - I want to stop the temp target in 45 minutes
- I exercised
  - I exercised for 30 minutes
  - I'm exercising for 1 hour
  - I will exercise for an hour at 5:30 am tomorrow

### [`openaps`](/README.md#openaps-openaps)

- OpenAPS will be offline
  - I'll be offline at 10 pm today
  - I will go offline at 2 pm for 60 minutes
  - I'll be going offline for 2 hours and 15 minutes

## A note about names

All the formats with specific names will respond to questions for any first name. You don't need to configure anything with your PWD's name.

## The techy way to know what you can ask

To get the full picture, in the respective console for your virtual assistant, check the example phrases for each `intent`, and the values (including synonyms) of the "metric" `slot` (Alexa) or `entity` (Google Home). You can also just experiement with asking different questions to see what works.