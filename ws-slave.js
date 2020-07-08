/* jshint loopfunc: true */
var WebSocket = require('ws');

var noble = require('./index');

var serverMode = !process.argv[2];
var defaultScanUuid = process.argv[3];
var g_fEnableRealScanning = true;
var port = 0xB1e;
var host = process.argv[2];

var wss;

class NobleClientContext {
  peripherals = {};
  ws = null;

  activeScanServiceUuids = [];

  constructor(ws) {
    this.ws = ws;
    this.peripherals = {};
  }

  startScanning(serviceUuids, allowDuplicates) {
    this.activeScanServiceUuids = serviceUuids;
  }
  stopScanning() {
    this.activeScanServiceUuids = [];
  }
  isScanningForPeripheral(peripheral) {
    if(!peripheral) {
      // they're just asking if we're scanning at all
      return this.activeScanServiceUuids.length > 0;
    }
    if(peripheral && peripheral.advertisement && peripheral.advertisement.serviceUuids) {
      return peripheral.advertisement.serviceUuids.find((advertisedUuid) => {
        const scannedFor = this.activeScanServiceUuids.find((scannedUuid) => scannedUuid === advertisedUuid);
        return !!scannedFor;
      })
    }
    return false;
  }
}

const contexts = {};
let nextContextId = 0;

if (serverMode) {
  console.log('noble - ws slave - server mode');
  wss = new WebSocket.Server({
    port: 0xB1e
  });

  wss.on('connection', function (ws) {
    console.log('ws -> connection');

    const contextId = '' + nextContextId++;
    ws.contextId = contextId;
    contexts[contextId] = new NobleClientContext(ws);

    ws.on('message', (evt) => {
      onMessage(contextId, evt);
    });

    ws.on('close', function () {
      console.log(`ws -> close ${contextId}`);

      const ctx = contexts[contextId];

      // go through all the peripherals connected to this websocket connection
      for(var key in ctx.peripherals) {
        const p = ctx.peripherals[key];

        // if this peripheral was actively connected to this websocket, treat the bluetooth connection like it died.
        // and also, make sure the bluetooth connection gets killed
        if(p.contextId === contextId) {
          p.disconnect();
        }
      }
      delete contexts[contextId];

      if(!isAnyContextScanning()) {
        noble.stopScanning();
      }
      noble.removeAllListeners('stateChange');
      ws.removeAllListeners('close');
      ws.removeAllListeners('open');
      ws.removeAllListeners('message');
    });

    noble.on('stateChange', function (state) {
      sendEvent(contextId, {
        type: 'stateChange',
        state: state
      });
    });

    // Send poweredOn if already in this state.
    if (noble.state === 'poweredOn') {
      sendEvent(contextId, {
        type: 'stateChange',
        state: 'poweredOn'
      });
    }
  });
}


// TODO: open/close ws on state change

function sendEvent (contextId, event) {
  if(!event) {
    debugger;
  }
  var message = JSON.stringify(event);

  if(!event.serviceUuid || (event.serviceUuid !== "1818")) {
    console.log(`ws -> send ${contextId}: ${message}`);
  }

  const ctx = contexts[contextId];
  if(!ctx) {
    // err, guess this guy disconnected?
    console.log("they wanted to send a message ", message, " to context " + contextId);
    return;
  }
  const ws = contexts[contextId].ws;
  ws.send(message);
}

function isAnyContextScanning() {
  for(var key in contexts) {
    const ctx = contexts[key];
    if(ctx.isScanningForPeripheral()) {
      return true;
    }
  }
  return false;
}

class Deferred {
  resolve;
  reject;
  promise;
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}
scanningLockout = new Deferred();
scanningLockout.resolve();

var connectSerialize = Promise.resolve();

var onMessage = function (contextId, message) {

  var command = JSON.parse(message);

  var action = command.action;
  var peripheralUuid = command.peripheralUuid;
  var serviceUuids = command.serviceUuids;
  var serviceUuid = command.serviceUuid;
  var characteristicUuids = command.characteristicUuids;
  var characteristicUuid = command.characteristicUuid;
  var data = command.data ? Buffer.from(command.data, 'hex') : null;
  var withoutResponse = command.withoutResponse;
  var broadcast = command.broadcast;
  var notify = command.notify;
  var descriptorUuid = command.descriptorUuid;
  var handle;
  console.log(contextId + ": " + action);

  const ctx = contexts[contextId];

  var peripheral = ctx.peripherals[peripheralUuid];
  var service = null;
  var characteristic = null;
  var descriptor = null;

  if (peripheral && serviceUuid) {
    var services = peripheral.services;

    for (var i in services) {
      if (services[i].uuid === serviceUuid) {
        service = services[i];

        if (characteristicUuid) {
          var characteristics = service.characteristics;

          for (var j in characteristics) {
            if (characteristics[j].uuid === characteristicUuid) {
              characteristic = characteristics[j];

              if (descriptorUuid) {
                var descriptors = characteristic.descriptors;

                for (var k in descriptors) {
                  if (descriptors[k].uuid === descriptorUuid) {
                    descriptor = descriptors[k];
                    break;
                  }
                }
              }
              break;
            }
          }
        }
        break;
      }
    }
  }

  if (action === 'startScanning') {

    // if no context is scanning right now, start a scan for absolutely everything.
    // we will narrow things down later and send messages to relevant listeners in the 'discover' handler
    console.log("a context ", contextId, " wants to start scanning");
    if(!isAnyContextScanning()) {
      noble.startScanning(serviceUuids, command.allowDuplicates);
      console.log("any nobody was scanning before, so now we're scanning!");
      scanningLockout = new Deferred();
    }
    ctx.startScanning(serviceUuids, command.allowDuplicates);
  } else if (action === 'stopScanning') {
    ctx.stopScanning();
    console.log("context ", contextId, " wants to stop scanning");
    if(!isAnyContextScanning()) {
      console.log("all contexts have stopped scanning");
      noble.stopScanning();
      scanningLockout.resolve();
    }
  } else if (action === 'connect') {

    console.log(contextId + ": connect request.  Waiting for scanning lockout");
    scanningLockout.promise.then(() => {
      console.log("scanning lockout resolved");
      peripheral.once('connect', function () {
        console.log(contextId + "connect callback happened to ws-slave for " + peripheral.uuid + " and context " + contextId);
        sendEvent(contextId, {
          type: 'connect',
          peripheralUuid: this.uuid
        });
      });
      peripheral.once('disconnect', function () {
        sendEvent(contextId, {
          type: 'disconnect',
          peripheralUuid: this.uuid
        });
    
        wipeOldListeners(peripheral, true);
        peripheral.contextId = null;
      });
      peripheral.connect(undefined, contextId);
  
      console.log(contextId + "ws-slave connection to " + peripheralUuid + " starting");
    })

  } else if (action === 'disconnect') {
    peripheral.disconnect();
  } else if (action === 'updateRssi') {
    peripheral.once('rssiUpdate',  (rssi) => {
      sendEvent(key, {
        type: 'rssiUpdate',
        peripheralUuid: peripheral.uuid,
        rssi: rssi
      });
    });
    peripheral.updateRssi();
  } else if (action === 'discoverServices') {


    peripheral.once('servicesDiscover', function (err, services) {
      console.log("servicesDiscover callback for " + peripheral.uuid);

      var serviceUuids = services.map((service) => service.uuid);

      sendEvent(contextId, {
        type: 'servicesDiscover',
        peripheralUuid: this.uuid,
        serviceUuids: serviceUuids
      });
    });
    peripheral.discoverServices(command.uuids);
  } else if (action === 'discoverIncludedServices') {
    service.once('includedServicesDiscover', (includedServiceUuids) => {
      sendEvent(contextId, {
        type: 'includedServicesDiscover',
        peripheralUuid: peripheral.uuid,
        serviceUuid: this.uuid,
        includedServiceUuids: includedServiceUuids
      });
    });

    service.discoverIncludedServices(serviceUuids);
  } else if (action === 'discoverCharacteristics') {
    service.once('characteristicsDiscover', (characteristics) => {

      var discoveredCharacteristics = [];

      var read = function (data, isNotification) {
        var characteristic = this;

        sendEvent(contextId, {
          type: 'read',
          peripheralUuid: peripheral.uuid,
          serviceUuid: service.uuid,
          characteristicUuid: characteristic.uuid,
          data: data.toString('hex'),
          isNotification: isNotification
        });
      };


      var broadcast = function (state) {
        var characteristic = this;

        sendEvent(contextId, {
          type: 'broadcast',
          peripheralUuid: peripheral.uuid,
          serviceUuid: service.uuid,
          characteristicUuid: characteristic.uuid,
          state: state
        });
      };

      var notify = function (state) {
        var characteristic = this;

        sendEvent(contextId, {
          type: 'notify',
          peripheralUuid: peripheral.uuid,
          serviceUuid: service.uuid,
          characteristicUuid: characteristic.uuid,
          state: state
        });
      };

      var descriptorsDiscover = function (descriptors) {
        var characteristic = this;

        var discoveredDescriptors = [];

        var valueRead = function (data) {
          var descriptor = this;

          sendEvent(contextId, {
            type: 'valueRead',
            peripheralUuid: peripheral.uuid,
            serviceUuid: service.uuid,
            characteristicUuid: characteristic.uuid,
            descriptorUuid: descriptor.uuid,
            data: data.toString('hex')
          });
        };

        var valueWrite = function (data) {
          var descriptor = this;

          sendEvent(contextId, {
            type: 'valueWrite',
            peripheralUuid: peripheral.uuid,
            serviceUuid: service.uuid,
            characteristicUuid: characteristic.uuid,
            descriptorUuid: descriptor.uuid
          });
        };

        for (var k in descriptors) {
          descriptors[k].on('valueRead', valueRead);

          descriptors[k].on('valueWrite', valueWrite);

          discoveredDescriptors.push(descriptors[k].uuid);
        }

        sendEvent(contextId, {
          type: 'descriptorsDiscover',
          peripheralUuid: peripheral.uuid,
          serviceUuid: service.uuid,
          characteristicUuid: this.uuid,
          descriptors: discoveredDescriptors
        });
      };

      for (var j = 0; j < characteristics.length; j++) {
        characteristics[j].on('read', read);


        characteristics[j].on('broadcast', broadcast);

        characteristics[j].on('notify', notify);

        characteristics[j].on('descriptorsDiscover', descriptorsDiscover);

        discoveredCharacteristics.push({
          uuid: characteristics[j].uuid,
          properties: characteristics[j].properties
        });
      }

      sendEvent(contextId, {
        type: 'characteristicsDiscover',
        peripheralUuid: peripheral.uuid,
        serviceUuid: service.uuid,
        characteristics: discoveredCharacteristics
      });
    })
    service.discoverCharacteristics(characteristicUuids);
  } else if (action === 'read') {

    peripheral.once('handleRead', function (handle, data) {
      sendEvent(contextId, {
        type: 'handleRead',
        peripheralUuid: this.uuid,
        handle: handle,
        data: data.toString('hex')
      });
    });
    characteristic.read();
  } else if (action === 'write') {

    let fnHandleWrite;
    peripheral.once('handleWrite', fnHandleWrite = function (handle) {
      sendEvent(contextId, {
        type: 'handleWrite',
        peripheralUuid: this.uuid,
        handle: handle
      });
    });
    characteristic.once('write', () => {

      sendEvent(contextId, {
        type: 'write',
        peripheralUuid: peripheral.uuid,
        serviceUuid: service.uuid,
        characteristicUuid: characteristic.uuid
      });
      peripheral.off('handleWrite', fnHandleWrite);
    });
    characteristic.write(data, withoutResponse);
  } else if (action === 'broadcast') {
    characteristic.broadcast(broadcast);
  } else if (action === 'notify') {

    peripheral.once('handleNotify', function (handle, data) {
      sendEvent(contextId, {
        type: 'handleNotify',
        peripheralUuid: this.uuid,
        handle: handle,
        data: data.toString('hex')
      });
    });
    characteristic.notify(notify);
  } else if (action === 'discoverDescriptors') {
    characteristic.discoverDescriptors();
  } else if (action === 'readValue') {
    descriptor.readValue();
  } else if (action === 'writeValue') {
    descriptor.writeValue(data);
  } else if (action === 'readHandle') {
    peripheral.readHandle(handle);
  } else if (action === 'writeHandle') {
    peripheral.writeHandle(handle, data, withoutResponse);
  }
};

function wipeOldListeners(peripheral, andThisToo) {
  console.log("wiping listeners from " + peripheral.uuid + " / " + peripheral.contextId + " / " + andThisToo);
  for (var i in peripheral.services) {
    for (var j in peripheral.services[i].characteristics) {
      for (var k in peripheral.services[i].characteristics[j].descriptors) {
        peripheral.services[i].characteristics[j].descriptors[k].removeAllListeners();
      }

      peripheral.services[i].characteristics[j].removeAllListeners();
    }
    peripheral.services[i].removeAllListeners();
  }

  if(andThisToo) {
    peripheral.removeAllListeners();
  }
  console.log("wiped listeners from " + peripheral.uuid + " / " + andThisToo);
}

noble.on('discover', function (peripheral) {

  for(var key in contexts) {
    const ctx = contexts[key];

    if(ctx.isScanningForPeripheral(peripheral)) {

      const oldPeripheral = ctx.peripherals[peripheral.uuid];
      if(oldPeripheral) {
        for(var key in peripheral) {
          if(peripheral[key] !== oldPeripheral[key]) {
            console.log(key, " changed to ", peripheral[key]);
          }
        }
      } else {
        ctx.peripherals[peripheral.uuid] = peripheral;
      }

    
    
    
    
    
    
      sendEvent(key, {
        type: 'discover',
        peripheralUuid: peripheral.uuid,
        address: peripheral.address,
        addressType: peripheral.addressType,
        connectable: peripheral.connectable,
        advertisement: {
          localName: peripheral.advertisement.localName,
          txPowerLevel: peripheral.advertisement.txPowerLevel,
          serviceUuids: peripheral.advertisement.serviceUuids,
          manufacturerData: (peripheral.advertisement.manufacturerData ? peripheral.advertisement.manufacturerData.toString('hex') : null),
          serviceData: (peripheral.advertisement.serviceData ? peripheral.advertisement.serviceData.toString('hex') : null)
        },
        rssi: peripheral.rssi
      });

    }
  }
});
