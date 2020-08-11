const events = require('events');
const util = require('util');

var pCounter = 0;

function assert(f, reason) {
  if(!f) {
    console.error(reason);
    debugger;
  }
}

function Peripheral (noble, id, address, addressType, connectable, advertisement, rssi) {
  this._noble = noble;
  assert(this._noble, "we need noble!");

  this.pCounter = pCounter++;
  this.id = id;
  this.uuid = id; // for legacy
  this.address = address;
  this.addressType = addressType;
  this.connectable = connectable;
  this.advertisement = advertisement;
  this.rssi = rssi;
  this.services = null;
  this.mtu = null;
  this.state = 'disconnected';
}

util.inherits(Peripheral, events.EventEmitter);

Peripheral.prototype.toString = function () {
  return JSON.stringify({
    id: this.id,
    address: this.address,
    addressType: this.addressType,
    connectable: this.connectable,
    advertisement: this.advertisement,
    rssi: this.rssi,
    mtu: this.mtu,
    state: this.state
  });
};


const connect = function (callback, contextId) {
  //console.log("trying to connect to peripheral " + this.id);
  this.once('connect', error => {
    //console.log("connection to peripheral " + this.id + " complete!");
    if(!error) {
      this.contextId = contextId
    }
    if (callback) {
      callback(error);
    }
  });

  if (this.state === 'connected') {
    //console.log("peripheral " + this.advertisement.localName + " is already connected!");
    this.emit('connect');
  } else {
    //console.log("noble.peripheral: connecting " + this.advertisement.localName + " / " + this.id + "...");
    this.state = 'connecting';
    this._noble.connect(this.id);
  }
};

Peripheral.prototype.connect = connect;
Peripheral.prototype.connectAsync = util.promisify(connect);

const disconnect = function (callback) {
  this.once('disconnect', () => {
    if (callback) {
      callback(null);
    }
  });
  this.state = 'disconnecting';
  this._noble.disconnect(this.id);
  this.contextId = null;
};

Peripheral.prototype.disconnect = disconnect;
Peripheral.prototype.disconnectAsync = util.promisify(disconnect);

const updateRssi = function (callback) {
  if (callback) {
    this.once('rssiUpdate', rssi => {
      callback(null, rssi);
    });
  }

  this._noble.updateRssi(this.id);
};

Peripheral.prototype.updateRssi = updateRssi;
Peripheral.prototype.updateRssiAsync = util.promisify(updateRssi);

const discoverServices = function (uuids, callback) {
  if (callback) {
    this.once('servicesDiscover', (err, services) => {
      callback(err, services);
    });
  }

  assert(this._noble, "we need noble!");
  this._noble.discoverServices(this.id, uuids);
};

Peripheral.prototype.discoverServices = discoverServices;
Peripheral.prototype.discoverServicesAsync = function (uuids) {
  return util.promisify((callback) => this.discoverServices(uuids, callback))();
};

const discoverSomeServicesAndCharacteristics = function (serviceUuids, characteristicsUuids, callback) {
  this.discoverServices(serviceUuids, (err, services) => {
    if (err) {
      callback(err, null, null);
      return;
    }
    let numDiscovered = 0;
    const allCharacteristics = [];

    for (const i in services) {
      const service = services[i];

      service.discoverCharacteristics(characteristicsUuids, (error, characteristics) => {
        numDiscovered++;

        // TODO: handle `error`?
        if (error === null) {
          for (const j in characteristics) {
            const characteristic = characteristics[j];

            allCharacteristics.push(characteristic);
          }
        }

        if (numDiscovered === services.length) {
          if (callback) {
            callback(null, services, allCharacteristics);
          }
        }
      });
    }
  });
};

Peripheral.prototype.discoverSomeServicesAndCharacteristics = discoverSomeServicesAndCharacteristics;
Peripheral.prototype.discoverSomeServicesAndCharacteristicsAsync = function (serviceUuids, characteristicsUuids) {
  return new Promise((resolve, reject) =>
    this.discoverSomeServicesAndCharacteristics(
      serviceUuids,
      characteristicsUuids,
      (error, services, characteristics) =>
        error
          ? reject(error)
          : resolve({
            services,
            characteristics
          })
    )
  );
};

const discoverAllServicesAndCharacteristics = function (callback) {
  this.discoverSomeServicesAndCharacteristics([], [], callback);
};

Peripheral.prototype.discoverAllServicesAndCharacteristics = discoverAllServicesAndCharacteristics;
Peripheral.prototype.discoverAllServicesAndCharacteristicsAsync = function () {
  return new Promise((resolve, reject) =>
    this.discoverAllServicesAndCharacteristics(
      (error, services, characteristics) =>
        error
          ? reject(error)
          : resolve({
            services,
            characteristics
          })
    )
  );
};

const readHandle = function (handle, callback) {
  if (callback) {
    this.once(`handleRead${handle}`, data => {
      callback(null, data);
    });
  }

  this._noble.readHandle(this.id, handle);
};

Peripheral.prototype.readHandle = readHandle;
Peripheral.prototype.readHandleAsync = util.promisify(readHandle);

const writeHandle = function (handle, data, withoutResponse, callback) {
  if (!(data instanceof Buffer)) {
    throw new Error('data must be a Buffer');
  }

  if (callback) {
    this.once(`handleWrite${handle}`, () => {
      callback(null);
    });
  }

  this._noble.writeHandle(this.id, handle, data, withoutResponse);
};

Peripheral.prototype.writeHandle = writeHandle;
Peripheral.prototype.writeHandleAsync = util.promisify(writeHandle);

module.exports = Peripheral;
