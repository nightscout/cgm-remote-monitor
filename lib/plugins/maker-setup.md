Nightscout/IFTTT Maker
======================================

## Overview

 In addition to the normal web based alarms, and pushover, there is also integration for [IFTTT Maker](https://ifttt.com/maker).
  
 With Maker you are able to integrate with all the other [IFTTT Channels](https://ifttt.com/channels).  For example you can send a tweet when there is an alarm, change the color of hue light, send an email, send and sms, and so much more.
 
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

  Start [creating a recipe](https://ifttt.com/myrecipes/personal/new)
  
  1. Choose a Trigger Channel
  2. Choose a Trigger
  3. Complete Trigger Fields
  4. That
  5. Choose an Action
  6. Complete Action Fields
  7. Create and Connect
 
