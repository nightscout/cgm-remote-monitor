#!/bin/sh
  # program to check wifi and reset if not running
  IPTEST=8.8.8.8
  iwconfig=/sbin/iwconfig
  rfkill=/usr/sbin/rfkill
  DEVICE=`$iwconfig | egrep 802 | awk ' {print $1}'`

  if ping -c 1 $IPTEST >/dev/null 2>&1 ; then
    #echo $IPTEST ok
    exit 0
  else
    # Failed, try to reset wifi - sometimes works ok
    (
    date
    echo "Stopping wifi...."
    nmcli nm wifi off
    sleep 3
    echo Starting wifi....
    nmcli nm wifi on
    sleep 10
    if ping -c 1 $IPTEST >/dev/null 2>&1 ; then
        #echo $IPTEST ok
        exit 0
    else
        # try another way
        echo "Stopping wifi $iwconfig ...."
        $iwconfig
        $iwconfig $DEVICE txpower off
        sleep 3
        echo starting wifi....
        $iwconfig $DEVICE txpower auto
    fi
    sleep 10
    if ping -c 1 $IPTEST >/dev/null 2>&1 ; then
        #echo $IPTEST ok
        exit 0
    else
        # try another way
        echo "stopping wifi $rfkill ...."
        $rfkill list
        $rfkill block wifi
        sleep 3
        echo starting wifi....
        $rfkill unblock wifi
    fi
    #echo closing the session
    #sleep 3
    #iftop -i $DEVICE
    )  >> $HOME/wificheck.log 2>&1
  fi
  exit 0
