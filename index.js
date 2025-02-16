"use strict";

const crypto = require("crypto");
const events = require("events");
const Joi = require("@hapi/joi");
const os = require("os");
const pkg = require("./package.json");
const util = require("util");

// Default expire time for a lock in seconds
const DEFAULT_EXPIRE_TIME = 60 * 60 * 24; // 1 day

const FailClosed = function(config) {
  if (!(this instanceof FailClosed)) {
    return new FailClosed(config);
  }
  const self = this;

  self._config = config;

  const configValidationResult = Joi.validate(self._config, FailClosed.schema.config, {
    abortEarly: false,
    convert: false,
  });
  if (configValidationResult.error) {
    throw configValidationResult.error;
  }
  self._dynamodb = self._config.dynamodb;
  self._lockTable = self._config.lockTable;
  self._partitionKey = self._config.partitionKey;
  self._acquirePeriodMs = self._config.acquirePeriodMs;
  self._retryCount = self._config.retryCount === undefined ? 1 : self._config.retryCount;
};

FailClosed.schema = {
  config: require("./schema/failClosedConfig.js"),
};

FailClosed.prototype.acquireLock = function(options, callback) {
  const self = this;
  const workflow = new events.EventEmitter();
  setImmediate(() =>
    workflow.emit("start", {
      id: options.id,
      owner:
        self._config.owner ||
        `${pkg.name}@${pkg.version}_${os.userInfo().username}@${os.hostname()}`,
      retryCount: self._config.retryCount,
      guid: crypto.randomBytes(64),
      expiresAt: options.expiresAt || DEFAULT_EXPIRE_TIME,
    })
  );
  workflow.on("start", dataBag => workflow.emit("acquire lock", dataBag));
  workflow.on("acquire lock", dataBag => {
    const params = {
      TableName: self._lockTable,
      Item: {
        owner: dataBag.owner,
        guid: dataBag.guid,
        expiresAt: dataBag.expiresAt,
      },
      ConditionExpression: "attribute_not_exists(#partitionKey)",
      ExpressionAttributeNames: {
        "#partitionKey": self._partitionKey,
      },
    };
    params.Item[self._partitionKey] = dataBag.id;
    self._dynamodb.put(params, (error, data) => {
      if (error) {
        if (error.code === "ConditionalCheckFailedException") {
          if (dataBag.retryCount > 0) {
            return workflow.emit("retry acquire lock", dataBag);
          } else {
            const err = new Error("Failed to acquire lock.");
            err.code = "FailedToAcquireLock";
            err.originalError = error;
            return callback(err);
          }
        }
        return callback(error);
      }
      return callback(
        undefined,
        new Lock({
          dynamodb: self._dynamodb,
          failClosed: true,
          id: dataBag.id,
          lockTable: self._lockTable,
          partitionKey: self._partitionKey,
          guid: dataBag.guid,
        })
      );
    });
  });
  workflow.on("retry acquire lock", dataBag => {
    dataBag.retryCount--;
    setTimeout(() => workflow.emit("acquire lock", dataBag), self._acquirePeriodMs);
  });
};

const FailOpen = function(config) {
  if (!(this instanceof FailOpen)) {
    return new FailOpen(config);
  }
  const self = this;

  self._config = config;

  const configValidationResult = Joi.validate(
    self._config,
    FailOpen.schema.config, // partitionKey NOT in [leaseDurationMs, owner, guid]
    {
      abortEarly: false,
      convert: false,
    }
  );
  if (configValidationResult.error) {
    throw configValidationResult.error;
  }
  self._dynamodb = self._config.dynamodb;
  self._lockTable = self._config.lockTable;
  self._partitionKey = self._config.partitionKey;
  self._heartbeatPeriodMs = self._config.heartbeatPeriodMs;
  self._leaseDurationMs = self._config.leaseDurationMs;
  self._trustLocalTime = self._config.trustLocalTime;
  self._retryCount = self._config.retryCount === undefined ? 1 : self._config.retryCount;
};

FailOpen.schema = {
  config: require("./schema/failOpenConfig.js"),
};

FailOpen.prototype.acquireLock = function(options, callback) {
  const self = this;
  const workflow = new events.EventEmitter();
  setImmediate(() =>
    workflow.emit("start", {
      id,
      owner:
        self._config.owner ||
        `${pkg.name}@${pkg.version}_${os.userInfo().username}@${os.hostname()}`,
      retryCount: self._config.retryCount,
      guid: crypto.randomBytes(64),
      expiresAt: options.expiresAt || DEFAULT_EXPIRE_TIME,
    })
  );
  workflow.on("start", dataBag => workflow.emit("check for existing lock", dataBag));
  workflow.on("check for existing lock", dataBag => {
    const params = {
      TableName: self._lockTable,
      Key: {},
      ConsistentRead: true,
    };
    params.Key[self._partitionKey] = dataBag.id;
    self._dynamodb.get(params, (error, data) => {
      if (error) {
        return callback(error);
      }
      if (!data.Item) {
        dataBag.fencingToken = 1;
        return workflow.emit("acquire new lock", dataBag);
      }
      dataBag.lock = data.Item;
      dataBag.fencingToken = dataBag.lock.fencingToken + 1;
      const leaseDurationMs = parseInt(dataBag.lock.leaseDurationMs);
      let timeout;
      if (self._trustLocalTime) {
        const lockAcquiredTimeUnixMs = parseInt(dataBag.lock.lockAcquiredTimeUnixMs);
        const localTimeUnixMs = new Date().getTime();
        timeout = Math.max(0, leaseDurationMs - (localTimeUnixMs - lockAcquiredTimeUnixMs));
      } else {
        timeout = leaseDurationMs;
      }
      return setTimeout(() => workflow.emit("acquire existing lock", dataBag), timeout);
    });
  });
  workflow.on("acquire new lock", dataBag => {
    const params = {
      TableName: self._lockTable,
      Item: {
        fencingToken: dataBag.fencingToken,
        leaseDurationMs: self._leaseDurationMs,
        owner: dataBag.owner,
        guid: dataBag.guid,
        expiresAt: dataBag.expiresAt,
      },
      ConditionExpression: "attribute_not_exists(#partitionKey)",
      ExpressionAttributeNames: {
        "#partitionKey": self._partitionKey,
      },
    };
    if (self._trustLocalTime) {
      params.Item.lockAcquiredTimeUnixMs = new Date().getTime();
    }
    params.Item[self._partitionKey] = dataBag.id;
    self._dynamodb.put(params, (error, data) => {
      if (error) {
        if (error.code === "ConditionalCheckFailedException") {
          if (dataBag.retryCount > 0) {
            dataBag.retryCount--;
            return workflow.emit("check for existing lock", dataBag);
          } else {
            const err = new Error("Failed to acquire lock.");
            err.code = "FailedToAcquireLock";
            err.originalError = error;
            return callback(err);
          }
        }
        return callback(error);
      }
      return workflow.emit("configure acquired lock", dataBag);
    });
  });
  workflow.on("acquire existing lock", dataBag => {
    const params = {
      TableName: self._lockTable,
      Item: {
        fencingToken: dataBag.fencingToken,
        leaseDurationMs: self._leaseDurationMs,
        owner: dataBag.owner,
        guid: dataBag.guid,
      },
      ConditionExpression:
        "attribute_not_exists(#partitionKey) or (guid = :guid and fencingToken = :fencingToken)",
      ExpressionAttributeNames: {
        "#partitionKey": self._partitionKey,
      },
      ExpressionAttributeValues: {
        ":fencingToken": dataBag.lock.fencingToken,
        ":guid": dataBag.lock.guid,
      },
    };
    if (self._trustLocalTime) {
      params.Item.lockAcquiredTimeUnixMs = new Date().getTime();
    }
    params.Item[self._partitionKey] = dataBag.id;
    self._dynamodb.put(params, (error, data) => {
      if (error) {
        if (error.code === "ConditionalCheckFailedException") {
          if (dataBag.retryCount > 0) {
            dataBag.retryCount--;
            return workflow.emit("check for existing lock", dataBag);
          } else {
            const err = new Error("Failed to acquire lock.");
            err.code = "FailedToAcquireLock";
            err.originalError = error;
            return callback(err);
          }
        }
        return callback(error);
      }
      return workflow.emit("configure acquired lock", dataBag);
    });
  });
  workflow.on("configure acquired lock", dataBag => {
    return callback(
      undefined,
      new Lock({
        dynamodb: self._dynamodb,
        fencingToken: dataBag.fencingToken,
        guid: dataBag.guid,
        heartbeatPeriodMs: self._heartbeatPeriodMs,
        id: dataBag.id,
        leaseDurationMs: self._leaseDurationMs,
        lockTable: self._lockTable,
        owner: dataBag.owner,
        partitionKey: self._partitionKey,
        trustLocalTime: self._trustLocalTime,
      })
    );
  });
};

const Lock = function(config) {
  const self = this;
  events.EventEmitter.call(self);

  self._config = config;
  self._dynamodb = self._config.dynamodb;
  self._failClosed = self._config.failClosed;
  self._fencingToken = self._config.fencingToken;
  self._guid = self._config.guid;
  self._heartbeatPeriodMs = self._config.heartbeatPeriodMs;
  self._id = self._config.id;
  self._leaseDurationMs = self._config.leaseDurationMs;
  self._lockTable = self._config.lockTable;
  self._owner = self._config.owner;
  self._partitionKey = self._config.partitionKey;
  self._released = false;
  self._trustLocalTime = self._config.trustLocalTime;

  self.fencingToken = self._fencingToken;

  if (self._heartbeatPeriodMs) {
    const refreshLock = function() {
      const newGuid = crypto.randomBytes(64);
      const params = {
        TableName: self._lockTable,
        Item: {
          fencingToken: self._fencingToken,
          leaseDurationMs: self._leaseDurationMs,
          owner: self._owner,
          guid: newGuid,
        },
        ConditionExpression: "attribute_exists(#partitionKey) and guid = :guid",
        ExpressionAttributeNames: {
          "#partitionKey": self._partitionKey,
        },
        ExpressionAttributeValues: {
          ":guid": self._guid,
        },
      };
      if (self._trustLocalTime) {
        params.Item.lockAcquiredTimeUnixMs = new Date().getTime();
      }
      params.Item[self._partitionKey] = self._id;
      self._dynamodb.put(params, (error, data) => {
        if (error) {
          return self.emit("error", error);
        }
        self._guid = newGuid;
        if (!self._released) {
          // See https://github.com/tristanls/dynamodb-lock-client/issues/1
          self._heartbeatTimeout = setTimeout(refreshLock, self._heartbeatPeriodMs);
        }
      });
    };
    self._heartbeatTimeout = setTimeout(refreshLock, self._heartbeatPeriodMs);
  }
};

util.inherits(Lock, events.EventEmitter);

Lock.prototype.release = function(callback) {
  const self = this;
  self._released = true;
  if (self._heartbeatTimeout) {
    clearTimeout(self._heartbeatTimeout);
    return self._releaseFailOpen(callback);
  } else {
    return self._releaseFailClosed(callback);
  }
};

Lock.prototype._releaseFailClosed = function(callback) {
  const self = this;
  const params = {
    TableName: self._lockTable,
    Key: {},
    ConditionExpression: `attribute_exists(#partitionKey) and guid = :guid`,
    ExpressionAttributeNames: {
      "#partitionKey": self._partitionKey,
    },
    ExpressionAttributeValues: {
      ":guid": self._guid,
    },
  };
  params.Key[self._partitionKey] = self._id;
  self._dynamodb.delete(params, (error, data) => {
    if (error && error.code === "ConditionalCheckFailedException") {
      const err = new Error("Failed to release lock.");
      err.code = "FailedToReleaseLock";
      err.originalError = error;
      return callback(err);
    }
    return callback(error);
  });
};

Lock.prototype._releaseFailOpen = function(callback) {
  const self = this;
  const params = {
    TableName: self._lockTable,
    Item: {
      fencingToken: self._fencingToken,
      leaseDurationMs: 1,
      owner: self._owner,
      guid: self._guid,
    },
    ConditionExpression: "attribute_exists(#partitionKey) and guid = :guid",
    ExpressionAttributeNames: {
      "#partitionKey": self._partitionKey,
    },
    ExpressionAttributeValues: {
      ":guid": self._guid,
    },
  };
  if (self._trustLocalTime) {
    params.Item.lockAcquiredTimeUnixMs = new Date().getTime();
  }
  params.Item[self._partitionKey] = self._id;
  self._dynamodb.put(params, (error, data) => {
    if (error && error.code === "ConditionalCheckFailedException") {
      // another process may have claimed lock already
      return callback();
    }
    return callback(error);
  });
};

module.exports = {
  FailClosed,
  FailOpen,
  Lock,
};
