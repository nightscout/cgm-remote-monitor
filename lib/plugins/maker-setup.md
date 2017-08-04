<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**

- [Nightscout/IFTTT Maker](#nightscoutifttt-maker)
  - [Overview](#overview)
  - [Events](#events)
  - [Configuration](#configuration)
  - [Create a recipe](#create-a-recipe)
    - [Start [creating a recipe](https://ifttt.com/myrecipes/personal/new)](#start-creating-a-recipehttpsiftttcommyrecipespersonalnew)
    - [1. Choose a Trigger Channel](#1-choose-a-trigger-channel)
    - [2. Choose a Trigger](#2-choose-a-trigger)
    - [3. Complete Trigger Fields](#3-complete-trigger-fields)
    - [4. That](#4-that)
    - [5. Choose an Action](#5-choose-an-action)
    - [6. Complete Action Fields](#6-complete-action-fields)
    - [7. Create and Connect](#7-create-and-connect)
    - [Result](#result)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

Nightscout/IFTTT Maker
======================================

## Overview

 In addition to the normal web based alarms, and pushover, there is also integration for [IFTTT Maker](https://ifttt.com/maker).
  
 With Maker you are able to integrate with all the other [IFTTT Channels](https://ifttt.com/channels).  For example you can send a tweet when there is an alarm, change the color of hue light, send an email, send and sms, and so much more.
 
## Events

 Plugins can create custom events, but all events sent to maker will be prefixed with `ns-`.  The core events are:

  * `ns-event` - This event is sent to the maker service for all alarms and notifications.  This is good catch all event for general logging.
  * `ns-allclear` - This event is sent to the maker service when an alarm has been ack'd or when the server starts up without triggering any alarms.  For example, you could use this event to turn a light to green.
  * `ns-info` - Plugins that generate notifications at the info level will cause this event to also be triggered.  It will be sent in addition to `ns-event`.
  * `ns-warning` - Alarms at the warning level with cause this event to also be triggered.  It will be sent in addition to `ns-event`.
  * `ns-urgent` - Alarms at the urgent level with cause this event to also be triggered.  It will be sent in addition to `ns-event`.
  * `ns-warning-high` - Alarms at the warning level with cause this event to also be triggered.  It will be sent in addition to `ns-event` and `ns-warning`.
  * `ns-urgent-high` - Alarms at the urgent level with cause this event to also be triggered.  It will be sent in addition to `ns-event` and `ns-urgent`.
  * `ns-warning-low` - Alarms at the warning level with cause this event to also be triggered.  It will be sent in addition to `ns-event` and `ns-warning`.
  * `ns-urgent-low` - Alarms at the urgent level with cause this event to also be triggered.  It will be sent in addition to `ns-event` and `ns-urgent`.
  * `ns-info-treatmentnotify` - When a treatment is entered into the care portal this event is triggered.  It will be sent in addition to `ns-event` and `ns-info`.
  * `ns-warning-bwp` - When the BWP plugin generates a warning alarm.  It will be sent in addition to `ns-event` and `ns-warning`.
  * `ns-urgent-bwp` - When the BWP plugin generates an urgent alarm.  It will be sent in addition to `ns-event` and `ns-urget`.

## Configuration

 1. Setup IFTTT account: [login](https://ifttt.com/login) or [create an account](https://ifttt.com/join)
 2. Find your secret key on the [maker page](https://ifttt.com/maker)
 3. Configure Nightscout by setting these environment variables:
  * `ENABLE` - `maker` should be added to the list of plugin, for example: `ENABLE="maker"`.
  * `MAKER_KEY` - Set this to your secret key that you located in step 2, for example: `MAKER_KEY="abcMyExampleabc123defjt1DeNSiftttmak-XQb69p"`
  
## Create a recipe

### Start [creating a recipe](https://ifttt.com/myrecipes/personal/new)
![screen shot 2015-06-29 at 10 58 48 pm](https://cloud.githubusercontent.com/assets/751143/8425240/bab51986-1eb8-11e5-88fb-5aed311896be.png)

### 1. Choose a Trigger Channel
  ![screen shot 2015-06-29 at 10 59 01 pm](https://cloud.githubusercontent.com/assets/751143/8425243/c007ace6-1eb8-11e5-96d1-b13f9c3d071f.png)

### 2. Choose a Trigger
  ![screen shot 2015-06-29 at 10 59 18 pm](https://cloud.githubusercontent.com/assets/751143/8425246/c77c5a4e-1eb8-11e5-9084-32ae40518ee0.png)

### 3. Complete Trigger Fields
  ![screen shot 2015-06-29 at 10 59 33 pm](https://cloud.githubusercontent.com/assets/751143/8425249/ced7b450-1eb8-11e5-95a3-730f6b9b2925.png)

### 4. That
  ![screen shot 2015-06-29 at 10 59 46 pm](https://cloud.githubusercontent.com/assets/751143/8425251/d46e1dc8-1eb8-11e5-91be-8dc731e308b2.png)
  
### 5. Choose an Action
  ![screen shot 2015-06-29 at 11 00 12 pm](https://cloud.githubusercontent.com/assets/751143/8425254/de634844-1eb8-11e5-8f09-cd43c41ccf3f.png)
  
### 6. Complete Action Fields
  **Example:** `Nightscout: {{Value1}} {{Value2}} {{Value3}}`
  
  ![screen shot 2015-06-29 at 11 02 14 pm](https://cloud.githubusercontent.com/assets/751143/8425267/f2da6dd4-1eb8-11e5-8e4d-cad2590d111f.png)
  ![screen shot 2015-06-29 at 11 02 21 pm](https://cloud.githubusercontent.com/assets/751143/8425272/f83ceb62-1eb8-11e5-8ea2-afd4dcbd391f.png)
  
### 7. Create and Connect
  ![screen shot 2015-06-29 at 11 02 43 pm](https://cloud.githubusercontent.com/assets/751143/8425277/fe52f618-1eb8-11e5-8d7f-e0b34eebe29a.png)

### Result
  ![cinpiqkumaa33u7](https://cloud.githubusercontent.com/assets/751143/8425925/e7d08d2c-1ebf-11e5-853c-cdc5381c4186.png)

 
