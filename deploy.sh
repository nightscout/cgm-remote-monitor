#!/bin/bash

# ----------------------
# KUDU Deployment Script
# Version: 0.1.10
# ----------------------

# Helpers
# -------

exitWithMessageOnError () {
  if [ ! $? -eq 0 ]; then
    echo "An error has occurred during web site deployment."
    echo $1
    exit 1
  fi
}

# Prerequisites
# -------------

# Verify node.js installed
hash node 2>/dev/null
exitWithMessageOnError "Missing node.js executable, please install node.js, if already installed make sure it can be reached from current environment."

# Setup
# -----

SCRIPT_DIR="${BASH_SOURCE[0]%\\*}"
SCRIPT_DIR="${SCRIPT_DIR%/*}"
ARTIFACTS=$SCRIPT_DIR/../artifacts
KUDU_SYNC_CMD=${KUDU_SYNC_CMD//\"}

if [[ ! -n "$DEPLOYMENT_SOURCE" ]]; then
  DEPLOYMENT_SOURCE=$SCRIPT_DIR
fi

if [[ ! -n "$NEXT_MANIFEST_PATH" ]]; then
  NEXT_MANIFEST_PATH=$ARTIFACTS/manifest

  if [[ ! -n "$PREVIOUS_MANIFEST_PATH" ]]; then
    PREVIOUS_MANIFEST_PATH=$NEXT_MANIFEST_PATH
  fi
fi

if [[ ! -n "$DEPLOYMENT_TARGET" ]]; then
  DEPLOYMENT_TARGET=$ARTIFACTS/wwwroot
else
  KUDU_SERVICE=true
fi

##################################################################################################################################
# Deployment
# ----------
# From http://www.cptloadtest.com/2013/12/03/Git-And-Grunt-Deploy-To-Windows-Azure.aspx

echo Handling node.js grunt deployment.

# 1. Select node version
selectNodeVersion

# 2. Install npm packages
if [ -e "$DEPLOYMENT_SOURCE/package.json" ]; then
  eval $NPM_CMD set ca ""
  eval $NPM_CMD install
  exitWithMessageOnError "npm failed"
fi

# 3. Install bower packages
if [ -e "$DEPLOYMENT_SOURCE/bower.json" ]; then
  eval $NPM_CMD install bower
  exitWithMessageOnError "installing bower failed"
  ./node_modules/.bin/bower install
  exitWithMessageOnError "bower failed"
fi

# 4. Run grunt
if [ -e "$DEPLOYMENT_SOURCE/Gruntfile.js" ]; then
  eval $NPM_CMD install grunt-cli
  exitWithMessageOnError "installing grunt failed"
  ./node_modules/.bin/grunt --no-color clean common dist
  exitWithMessageOnError "grunt failed"
fi

# 5. KuduSync to Target
"$KUDU_SYNC_CMD" -v 500 -f "$DEPLOYMENT_SOURCE/dist" -t "$DEPLOYMENT_TARGET" -n "$NEXT_MANIFEST_PATH" -p "$PREVIOUS_MANIFEST_PATH" -i ".git;.hg;.deployment;deploy.sh"
exitWithMessageOnError "Kudu Sync to Target failed"

# Post deployment stub
if [[ -n "$POST_DEPLOYMENT_ACTION" ]]; then
  POST_DEPLOYMENT_ACTION=${POST_DEPLOYMENT_ACTION//\"}
  cd "${POST_DEPLOYMENT_ACTION_DIR%\\*}"
  "$POST_DEPLOYMENT_ACTION"
  exitWithMessageOnError "post deployment action failed"
fi

echo "Finished successfully."
