# Deploying Nightscout onto Pivotal Web Services

Pivotal Web Services (PWS) is a public cloud platform offered by [Pivotal Software, Inc](http://pivotal.io).

## Forking the Repo
## Installing CF CLI
## Creating an account
## Target your Org and Space
## Create mLab MongoDB Service
## Changing Nightscout Settings

In PWS, you can view the settings for your app by selecting the app in the Space the app resides in, clicking the app name and then choosing Settings. You will see User Provided Environment Variables about half way down the page. The settings for nightscout are here in Name / Value pairs.

 Here you will find the `ENABLE` variable, which turn on and off many features of the app. These features are well documented in other places, but in short, you'll want at least these:

 `API_SECRET` to set the admin secret for your site.

 `MONGO_CONNECTION` holds the URI (or path) to the Mongo database.

## Deploying the Nightscout Application
```
$ cf push -f {path to manifest.yml}
```
