#!/usr/local/bin/perl -w

# This script is intended to be run as a cron job every n-minutes
# Or whatever the equiv is on windows
#
# Author: John A. [euclidjda](https://github.com/euclidjda)
# Source: https://gist.github.com/euclidjda/7c70c35d8ffc61c932cb

use strict;

use MongoDB;
use MongoDB::OID;
use POSIX qw(strftime);
use POSIX qw(tzset);

main();

sub main {

    # Set time-zone to pacific. I'm on the west coast but my server is EST. Don't ask.
    $ENV{TZ} = 'America/Los_Angeles';
    tzset;

    my $connection = MongoDB::Connection->new(host     => 'mongodb://ds053429.mongolab.com:53429',
					      username => 'nstest',
					      password => 'dexcom',
					      db_name  => 'nstest');

    my $database = $connection->get_database('nstest');

    my $collection = $database->get_collection('cgmdata');

    my $curtime = time();
    my $date    = int( sprintf("%d000",$curtime) );
    my $datestr = strftime "%m/%d/%Y %I:%M:%S %p", localtime($curtime);

    my $range = ($curtime % 1800)/900 - 1.0;
    my $svg   = int(360*(cos( 10.0 * $range / 3.14 ) / 2 + 0.5)) + 40;
    my $dir   = $range > 0.0 ? "FortyFiveDown" : "FortyFiveUp";

    $collection->insert( {
	"device"     => "dexcom" ,
	"date"       => $date    ,
	"dateString" => $datestr ,
	"sgv"        => $svg     ,
	"direction"  => $dir     } );

}
