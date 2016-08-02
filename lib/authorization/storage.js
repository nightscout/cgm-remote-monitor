'use strict';

var _ = require('lodash');
var crypto = require('crypto');
var shiroTrie = require('shiro-trie');

function init (env, ctx) {
  var storage = { };

  storage.reload = function reload (callback) {
    //TODO: load from mongo
    storage.roles = [
      {name: 'admin', permissions: ['*']}
      ,
      {name: 'careportal', permissions: ['api:treatments:create', 'alarms:default:ack']}
    ];

    storage.subjects = _.map([
      {_id: '579cf4ad65110bbfc193acc3', name: 'Dad Mac', roles: ['admin']}
      ,
      {_id: '579cf4ad65410bbfc193acc3', name: 'Dad Phone', roles: ['admin']}
      ,
      {_id: '579cf48d65110bbfc193acc3', name: 'Dad Tablet', roles: ['admin']}
      ,
      {_id: '579cef9265110bbfc193acbd', name: 'Mom Mac', roles: ['admin']}
      ,
      {_id: '579cef9265110bbfc193abad', name: 'Mom Phone', roles: ['admin']}
      ,
      {_id: '579ce3dd65110bbfc193acaf', name: 'Health Office', roles: ['careportal']}
    ], function eachSubject (subject) {

      if (env.api_secret) {
        var shasum = crypto.createHash('sha1');
        shasum.update(env.api_secret);
        shasum.update(subject._id);
        var digest = shasum.digest('base64').substring(0, 10);
        var abbrev = subject.name.toLowerCase().replace(/[\W]/g, '').substring(0, 10);
        subject.digest = digest;
        subject.accessToken = abbrev + '-' + digest;
      }

      return subject;
    });

    if (callback) {
      callback(null);
    }
  };

  storage.rolesToPermissions = function rolesToPermissions (roleNames) {
    var permissions = [ ];

    _.forEach(roleNames, function eachRoleName (roleName) {
      var role = _.find(storage.roles, {name: roleName});
      if (role) {
        permissions = permissions.concat(role.permissions);
      }
    });

    return _.uniq(permissions);
  };

  storage.findSubject = function findSubject (accessToken) {
    var prefix = _.last(accessToken.split('-'));

    if (prefix.length < 8) {
      return null;
    }

    return _.find(storage.subjects, function matches (subject) {
      return subject.digest.indexOf(prefix) === 0;
    });
  };

  storage.findSubjectPermissions = function findSubjectPermissions (accessToken) {
    var permissions = shiroTrie.new();

    var subject = storage.findSubject(accessToken);
    if (subject) {
      console.info('Found Subject', subject);
      permissions.add(storage.rolesToPermissions(subject.roles));
    }

    return permissions;
  };

  return storage;

}

module.exports = init;
