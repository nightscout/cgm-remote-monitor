<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**

- [Example Profiles](#example-profiles)
  - [Simple profile](#simple-profile)
  - [Profile can also use time periods for any field, for example:](#profile-can-also-use-time-periods-for-any-field-for-example)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

#Example Profiles

These are only examples, make sure you update all fields to fit your needs

##Simple profile
  ```json
  {
    "dia": 3,
    "carbs_hr": 20,
    "carbratio": 30,
    "sens": 100,
    "basal": 0.125,
    "target_low": 100,
    "target_high": 120
  }
  ```
  
##Profile can also use time periods for any field, for example:
  
  ```json
  {
    "carbratio": [
      {
        "time": "00:00",
        "value": 30
      },
      {
        "time": "06:00",
        "value": 25
      },
      {
        "time": "14:00",
        "value": 28
      }
    ],
    "basal": [
      {
        "time": "00:00",
        "value": 0.175
      },
      {
        "time": "02:30",
        "value": 0.125
      },
      {
        "time": "05:00",
        "value": 0.075
      },
      {
        "time": "08:00",
        "value": 0.100
      },
      {
        "time": "14:00",
        "value": 0.125
      },
      {
        "time": "20:00",
        "value": 0.175
      },
      {
        "time": "22:00",
        "value": 0.200
      }
    ]
  }
  ```
