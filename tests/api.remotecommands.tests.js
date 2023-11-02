'use strict';

var _ = require('lodash');
var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();
var assert = require('assert');

describe('Remote Commands API', function () {
  this.timeout(10000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  var api = require('../lib/api/');
  beforeEach(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    this.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', api(self.env, ctx));
      done();
    })
  });

  describe('Get Commands', async function () {

    it('Should return all commands', async function () {

      //Arrange
      await deleteAllCommands()
      var expectedCommand = pendingCommand()
      await insertCommand(expectedCommand)

      //Act
      const getResponse = await request(self.app)
        .get('/api/remotecommands/')
        .set('api-secret', known || '')

      //Assert
      getResponse.headers["content-type"].should.match(/json/)
      getResponse.status.should.equal(200)
      getResponse.body.length.should.equal(1)
      var firstCommand = getResponse.body[0]
      firstCommand.actionType.should.equal(expectedCommand.actionType)
      firstCommand.otp.should.equal(expectedCommand.otp)
      firstCommand.sendNotification.should.equal(expectedCommand.sendNotification)
      firstCommand.status.state.should.equal(expectedCommand.status.state)
      firstCommand.status.message.should.equal(expectedCommand.status.message)
    });

    it('Should return command by id', async function () {

      //Arrange
      await deleteAllCommands()
      var expectedCommand = pendingCommand()
      var insertResult = await insertCommand(expectedCommand)

      //Act
      const getResponse = await request(self.app)
        .get(`/api/remotecommands/${insertResult._id}`)
        .set('api-secret', known || '')

      //Assert
      getResponse.headers["content-type"].should.match(/json/)
      getResponse.status.should.equal(200)
      getResponse.body.length.should.equal(1)
      var firstCommand = getResponse.body[0]
      firstCommand.actionType.should.equal(expectedCommand.actionType)
      firstCommand.otp.should.equal(expectedCommand.otp)
      firstCommand.sendNotification.should.equal(expectedCommand.sendNotification)
      firstCommand.status.state.should.equal(expectedCommand.status.state)
      firstCommand.status.message.should.equal(expectedCommand.status.message)
    });

    it('Should return not found when unknown id used', async function () {

      //Arrange
      await deleteAllCommands()
      var expectedCommand = pendingCommand()

      //Act
      const getResponse = await request(self.app)
        .get('/api/remotecommands/639cdffd5d3b3f5b697370a7')
        .set('api-secret', known || '')

      //Assert
      //TODO: Consider how to return a 404 response instead
      getResponse.headers["content-type"].should.match(/json/)
      getResponse.status.should.equal(404)
    });

    it('Should not get commands before created_at', async function () {

      //Arrange
      await deleteAllCommands()
      var expectedCommand = pendingCommand()
      await insertCommand(expectedCommand)

      //Act
      const getResponse = await request(self.app)
        .get('/api/remotecommands/')
        .query(`find[created_at][$lt]=2015-09-07T23:59:59.000Z`)
        .set('api-secret', known || '')

      //Assert
      getResponse.headers["content-type"].should.match(/json/)
      getResponse.status.should.equal(200) //TODO: Should this be a not found result?
      getResponse.body.length.should.equal(0)
    });

    it('Should get commands after created_at', async function () {

      //Arrange
      await deleteAllCommands()
      var expectedCommand = pendingCommand()
      await insertCommand(expectedCommand)

      //Act
      const getResponse = await request(self.app)
        .get('/api/remotecommands/')
        .query(`find[created_at][$gt]=2015-09-07T23:59:59.000Z`)
        .set('api-secret', known || '')

      //Assert
      getResponse.headers["content-type"].should.match(/json/)
      getResponse.status.should.equal(200)
      getResponse.body.length.should.equal(1)
    });

  });

  describe('Delete Commands', async function () {

    it('All commands should delete', async function () {

      //Arrange
      await deleteAllCommands()
      await insertCommand(pendingCommand())

      //Act
      const deleteResponse = await request(self.app)
        .delete('/api/remotecommands/*')
        .set('api-secret', known || '')

      //Assert
      let commands = await allCommands()
      commands.length.should.equal(0)
    });

    //TODO: Check deletion with old commands in database - currently it will only lookback a few days if not created date given - change this.

    //TODO: Check deletion with various query parameters
  });

  describe('Post Commands', async function () {

    it('Should insert a command succesfully', async function () {

      //Arrange
      let testStartDateInMs = Date.now()
      await deleteAllCommands()
      let expectedCommand = pendingCommand()

      //Act
      const postResponse = await request(self.app)
        .post('/api/remotecommands/')
        .set('api-secret', known || '')
        .send(expectedCommand)

      //Assert
      postResponse.headers["content-type"].should.match(/json/)
      postResponse.status.should.equal(200)
      var commandResult = postResponse.body[0]
      postResponse.headers["location"].should.endWith(commandResult._id)
      commandResult._id.should.be.a.String().and.not.be.empty()
      commandResult.actionType.should.equal(expectedCommand.actionType)
      commandResult.otp.should.equal(expectedCommand.otp)
      commandResult.sendNotification.should.equal(expectedCommand.sendNotification)
      commandResult.status.state.should.equal(expectedCommand.status.state)
      commandResult.status.message.should.equal(expectedCommand.status.message)
      const insertDateFromPost = Date.parse(commandResult.created_at)
      insertDateFromPost.should.lessThanOrEqual(Date.now())
      insertDateFromPost.should.greaterThanOrEqual(testStartDateInMs)
    });

    //TODO: Check post that has invalid data - should return proper error
  });


  describe('Put Commands', async function () {

    it('Should Update a command succesfully', async function () {

      //Arrange
      await deleteAllCommands()
      let postCommand = pendingCommand()
      var postResult = await insertCommand(postCommand)
      var putCommand = {
        'status' : {
          'state': 'In-Progress',
          'message': 'Currently in-progress'
        }
      }

      //Act
      const putResponse = await request(self.app)
        .put(`/api/remotecommands/${postResult._id}`)
        .set('api-secret', known || '')
        .send(putCommand)

      //Assert
      putResponse.headers["content-type"].should.match(/application\/json/)
      putResponse.status.should.equal(200)
      let commands = await allCommands()
      commands.length.should.equal(1)
      var commandResult = commands[0]
      commandResult._id.should.equal(postResult._id)
      commandResult.actionType.should.equal(postCommand.actionType)
      commandResult.otp.should.equal(postCommand.otp)
      commandResult.sendNotification.should.equal(postCommand.sendNotification)
      commandResult.status.state.should.equal(putCommand.status.state)
      commandResult.status.message.should.equal(putCommand.status.message)
      //TODO: Consider checking the created_date? It probably shouldn't change.
    });

    it('Error should return when ID is missing in url', async function () {

      //Arrange
      await deleteAllCommands()
      let postCommand = pendingCommand()
      await insertCommand(postCommand)
      var putCommand = {
        'status' : {
          'state': 'In-Progress',
          'message': 'Currently in-progress'
        }
      }

      //Act
      const putResponse = await request(self.app)
        .put(`/api/remotecommands`)
        .set('api-secret', known || '')
        .send(putCommand)

      //Assert
      putResponse.headers["content-type"].should.match(/text/)
      putResponse.status.should.equal(404)
    });

    it('Error should return when ID is invalid', async function () {

      //Arrange
      await deleteAllCommands()
      let postCommand = inProgressCommand()
      let postResult = await insertCommand(postCommand)
      var putCommand = {
        'status' : {
          'state': 'In-Progress',
          'message': 'Currently in-progress'
        }
      }

      //Act
      const putResponse = await request(self.app)
        .put(`/api/remotecommands/${postResult._id}`)
        .set('api-secret', known || '')
        .send(putCommand)

      //Assert
      putResponse.headers["content-type"].should.match(/application\/json/)
      putResponse.status.should.equal(404)
    });
  });


  it('Error should return when In-Progress Update made on Non-Pending Command', async function () {

    //Arrange
    await deleteAllCommands()
    let postCommand = pendingCommand()
    await insertCommand(postCommand)
    var putCommand = {
      'status' : {
        'state': 'In-Progress',
        'message': 'Currently in-progress'
      }
    }

    //Act
    const putResponse = await request(self.app)
      .put(`/api/remotecommands`)
      .set('api-secret', known || '')
      .send(putCommand)

    //Assert
    putResponse.headers["content-type"].should.match(/text/)
    putResponse.status.should.equal(404)
  });

  //Utils

  function pendingCommand() {
    return {
      actionType: "bolus",
      actionOptions: {
        units: 1.0
      },
      otp: "12345",
      sendNotification: false,
      status: {
        state: "Pending",
        message: "Command Pending"
      }
    }
  }

  function inProgressCommand() {
    return {
      actionType: "carb",
      actionOptions: {
        grams: 10,
        absorption: 4.0
      },
      otp: "54321",
      sendNotification: false,
      status: {
        state: "In-Progress",
        message: "In-Progress"
      }
    }
  }

  async function insertCommand(command) {

    var startCommands = await allCommands()

    //Save
    const postResponse = await request(self.app)
      .post('/api/remotecommands/')
      .set('api-secret', known || '')
      .send(command)


    var endCommands = await allCommands()
    assert(startCommands.length == (endCommands.length - 1))

    return postResponse.body[0]
  }

  async function allCommands() {
    const getResponse = await request(self.app)
      .get('/api/remotecommands/')
      .set('api-secret', known || '')
    if (getResponse.body === 0) {
      return new Array()
    } else {
      console.log(getResponse.body)
      return getResponse.body
    }
  }

  //TODO: Put this in beforeEach?
  //I can't put an async method 
  //in there but maybe can put the callback variant?
  async function deleteAllCommands() {
    //Delete all remotecommands
    await request(self.app)
      .delete('/api/remotecommands/*')
      // .query(`find[_id][$eq]=*`)
      //TODO: Using a distant date in the past since a created_at date must be given
      .query(`find[created_at][$gt]=1900-09-07T23:59:59.000Z`)
      .set('api-secret', known || '')

    var commands = await allCommands()
    assert(commands.length == (0))
  }

});
