/* jshint loopfunc: true */
var WebSocket = require('ws');

var noble = require('./index');

var serverMode = !process.argv[2];
var defaultScanUuid = process.argv[3];
var g_fEnableRealScanning = true;

var wss;
console.log("recompile plz");
function assert(f, reason) {
  if(!f) {
    console.log(reason);
    debugger;
  }
}

class NobleClientContext {
  peripherals = {};
  ws = null;
  fConnected = false;
  id = -1;

  activeScanServiceUuids = [];

  constructor(ws, id) {
    this.ws = ws;
    this.peripherals = {};
    this.fConnected = false;
    this.allowDuplicates = false;
    this.id = id;
    this.uuidConnected = null;
  }

  startScanning(serviceUuids, allowDuplicates) {
    this.allowDuplicates = allowDuplicates;
    this.activeScanServiceUuids = serviceUuids;
    assert(serviceUuids.length > 0, "you gotta actually want to be scanning, right?");
    console.log("context ", this.id, " has entered scanning mode");
  }
  stopScanning() {
    console.log("context ", this.id, " has exited scanning mode");
    this.activeScanServiceUuids = [];
  }
  isConnected() {
    return this.fConnected;
  }
  getConnectedUuid() {
    return this.uuidConnected;
  }
  setConnected(isConnectedNow, uuidToWho) {
    this.fConnected = isConnectedNow;
    if(isConnectedNow) {
      this.uuidConnected = uuidToWho;
    } else {
      this.uuidConnected = null;
    }
  }
  isScanningForPeripheral(initialAdvertisement) {
    if(!initialAdvertisement) {
      // they're just asking if we're scanning at all
      return this.activeScanServiceUuids.length > 0;
    }
    if(initialAdvertisement && initialAdvertisement.serviceUuids) {
      return initialAdvertisement.serviceUuids.find((advertisedUuid) => {
        const scannedFor = this.activeScanServiceUuids.find((scannedUuid) => scannedUuid === advertisedUuid);
        return !!scannedFor;
      })
    }
    return false;
  }
}

const contexts = {};
let nextContextId = 0;


var g_currentScanUuids = [];
var g_fStoppedScanning = true;

if(defaultScanUuid) {
  g_currentScanUuids = [defaultScanUuid];
}

const CommandedScanState_Unknown = -1;
const CommandedScanState_StopScan = 0;
const CommandedScanState_StartScan = 1;

let currentCommandedState = CommandedScanState_Unknown;
function stopScanning() {
  if(currentCommandedState !== CommandedScanState_StopScan) {
    currentCommandedState = CommandedScanState_StopScan;
    noble.stopScanning();
  }
}
function startScanning(uuidsToHit, allowDuplicates) {
  if(currentCommandedState !== CommandedScanState_StartScan) {
    currentCommandedState = CommandedScanState_StartScan;
    noble.startScanning(uuidsToHit, allowDuplicates);
  }
}

function notifyScanRelevantEvent() {

  if(!isAnyContextConnected()) {

    let scanServiceUuids = {};
    for(var key in contexts) {
      if(key === 'eventNames') {debugger;}
      const ctx = contexts[key];
      if(ctx.isScanningForPeripheral()) {
        ctx.activeScanServiceUuids.forEach((uuid) => scanServiceUuids[uuid] = true);
      }
    }
    g_currentScanUuids.forEach((uuid) => scanServiceUuids[uuid] = true);

    const uuidsToHit = Object.keys(scanServiceUuids);

    uuidsToHit.sort();
    stopScanning();

    if(g_fEnableRealScanning) {
      try {
        startScanning(uuidsToHit, true);
      } catch(e) {
        
      }
      
    }
    g_currentScanUuids = uuidsToHit;
  } else {
    // some context is connected, so we gotta stop scanning
    //console.log("stopping scanning");
    stopScanning();
  }
}

if (serverMode) {
  console.log('noble - ws slave - server mode');
  wss = new WebSocket.Server({
    port: 0xB1e
  });


  const controlPort = 0xb1f;
  const myControlSocket = new WebSocket(`ws://localhost:${controlPort}`);
  myControlSocket.on('message', (msg) => {
    console.log("got a control message", msg);
    switch(msg) {
      case 'enable-real-scanning':
        g_fEnableRealScanning = true;
        notifyScanRelevantEvent();
        break;
      case 'disable-real-scanning':
        g_fEnableRealScanning = false;
        notifyScanRelevantEvent();
        break;
    }
  })
  myControlSocket.on('close', () => {
    // if our host closes, so do we.
    console.log("master process closed");
    process.exit(0);
  });
  myControlSocket.on('error', () => {
    // if we can't connect to our host, we close
    console.log("couldn't connect to master process");
    process.exit(0);
  })

  notifyScanRelevantEvent();

  wss.on('connection', function (ws) {
    console.log('ws -> connection');

    const contextId = '' + nextContextId++;
    ws.contextId = contextId;
    contexts[contextId] = new NobleClientContext(ws, contextId);

    if(contextId === 'eventNames') {debugger;}
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
          ctx.setConnected(false, null);
        }
      }
      delete contexts[contextId];

      let contextsLeft = 0;
      for(var key in contexts) {
        contextsLeft++;
      }
      console.log("There are ", contextsLeft, "contexts left");


      noble.removeAllListeners('stateChange');
      ws.removeAllListeners('close');
      ws.removeAllListeners('open');
      ws.removeAllListeners('message');
      notifyScanRelevantEvent();
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
    //console.log(`ws -> send ${contextId}: ${message}`);
  }

  const ctx = contexts[contextId];
  if(!ctx) {
    // err, guess this guy disconnected?
    //console.log("they wanted to send a message ", message, " to context " + contextId);
    return;
  }
  const ws = contexts[contextId].ws;
  ws.send(message);
}

function isAnyContextScanning() {
  for(var key in contexts) {
    const ctx = contexts[key];
    if(key === 'eventNames') {debugger;}
    if(ctx.isScanningForPeripheral()) {
      return true;
    }
  }
  return false;
}
function isAnyContextConnectedTo(uuid) {
  for(var key in contexts) {
    const ctx = contexts[key];
    if(key === 'eventNames') {debugger;}
    if(ctx.isConnected() && ctx.getConnectedUuid() === uuid) {
      return true;
    }
  }
  return false;
}
function isAnyContextConnected() {
  for(var key in contexts) {

    const ctx = contexts[key];
    if(ctx.isConnected()) {
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

var connectSerialize = Promise.resolve();


class NoticedPeripheral {
  peripheral;
  advertisement;
  tmNow;

  constructor(peripheral, tmNow) {
    this.peripheral = peripheral;
    this.advertisement = JSON.parse(JSON.stringify(peripheral.advertisement));

    assert(this.advertisement.serviceUuids.length > 0, "we can't have a noticed periph with no service uuids");

    this.tmNow = tmNow;
  }
};

const mapNoticedPeripherals = {};

function handleDiscoveredPeripheral(peripheral, initialAdvertisement) {

  assert(peripheral.once); // this needs to be a real peripheral, not some fake one

  for(var key in contexts) {
    const ctx = contexts[key];

    if(!ctx.isScanningForPeripheral()) {
      // if you're simply not scanning, that's totally fine
      console.log("context ", ctx.id, " is not scanning");
      continue;
    }

    if(ctx.isScanningForPeripheral(initialAdvertisement)) {
      console.log("context ", ctx.id, " is scanning for me!");
      const oldPeripheral = ctx.peripherals[peripheral.uuid];
      if(oldPeripheral) {
        // we already knew about this guy, no updates needed
      } else {
        ctx.peripherals[peripheral.uuid] = peripheral;
      }

      //console.log("context ", ctx.id, " is scanning for ", peripheral.advertisement.localName);

      const uuidsTouse = initialAdvertisement && initialAdvertisement.serviceUuids || peripheral.advertisement && peripheral.advertisement.serviceUuids;
      const sendObj = {
        type: 'discover',
        peripheralUuid: peripheral.uuid,
        address: peripheral.address,
        addressType: peripheral.addressType,
        connectable: peripheral.connectable,
        advertisement: {
          localName: peripheral.advertisement.localName,
          txPowerLevel: peripheral.advertisement.txPowerLevel,
          serviceUuids: uuidsTouse,
          manufacturerData: (peripheral.advertisement.manufacturerData ? peripheral.advertisement.manufacturerData.toString('hex') : null),
          serviceData: (peripheral.advertisement.serviceData ? peripheral.advertisement.serviceData.toString('hex') : null)
        },
        rssi: peripheral.rssi
      }
      console.log("telling context " + ctx.id + " about ", sendObj);
      sendEvent(key, sendObj);

    } else {
      console.log("context ", ctx.id, " is NOT scanning for ", peripheral.advertisement.localName, " which has ", peripheral.advertisement.serviceUuids, " b/c ctx wants ", ctx.activeScanServiceUuids);
    }
  }
}
function dumpNoticedPeripherals(andContinueSequence) {

  try {
    if(isAnyContextScanning()) {
      console.log("dumping past periphs to contexts");
      for(var key in mapNoticedPeripherals) {
        const noticedPeriph = mapNoticedPeripherals[key];
  
        if(isAnyContextConnectedTo(noticedPeriph.peripheral.uuid)) {
          // someone is already connected to this guy, so don't tell anyone else about it.
          console.log("not telling about ", noticedPeriph.advertisement.localName);
          continue;
        }
  
        const uuids = noticedPeriph.advertisement && noticedPeriph.advertisement.serviceUuids;
        console.log("faking like we just discovered ", noticedPeriph.advertisement.localName, " with ", uuids && uuids.length, " services");
  
        handleDiscoveredPeripheral(noticedPeriph.peripheral, noticedPeriph.advertisement);
      }
    }
  } catch(e) {
    debugger;
  }

  if(andContinueSequence) {
    setTimeout(() => {
      dumpNoticedPeripherals(andContinueSequence);
    }, 750);
  }
}
dumpNoticedPeripherals(true);

function handleScanningRequestFromContext(ctx, serviceUuids, allowDuplicates) {

  // nobody is currently connected, so we can start scanning.
  ctx.startScanning(serviceUuids, allowDuplicates);
  dumpNoticedPeripherals(false);
  notifyScanRelevantEvent();
}


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

  if(action !== 'write') {
    console.log(contextId + ": " + action);
  }


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

    handleScanningRequestFromContext(ctx, serviceUuids, command.allowDuplicates);


  } else if (action === 'stopScanning') {
    ctx.stopScanning();
    notifyScanRelevantEvent();
  } else if (action === 'connect') {

    peripheral.once('connect', function () {
      ctx.setConnected(true, this.uuid);
      console.log(contextId + "connect callback happened to ws-slave for " + peripheral.advertisement.localName + " and context " + contextId);
      sendEvent(contextId, {
        type: 'connect',
        peripheralUuid: this.uuid
      });

      notifyScanRelevantEvent();
    });
    peripheral.once('disconnect', function () {
      console.log("got event from peripheral ", peripheral.pCounter, peripheral.advertisement.localName, " about disconnecting");
      ctx.setConnected(false, null);
      sendEvent(contextId, {
        type: 'disconnect',
        peripheralUuid: this.uuid
      });
  
      wipeOldListeners(peripheral, true);
      peripheral.contextId = null;

      notifyScanRelevantEvent();
    });

    if(ctx.isConnected() && ctx.getConnectedUuid() === peripheralUuid) {
      // uhh... you were already connected...
      const name = peripheral.advertisement.localName;
      console.log(contextId + " hey dingus, you were already connected to " + name + ", but we're going to allow this");
      sendEvent(contextId, {
        type: 'connect',
        peripheralUuid: this.uuid
      });
    } else {
      console.log(contextId + "ws-slave connection to " + peripheral.advertisement.localName + " starting");
      peripheral.connect(undefined, contextId);
    }

    

  } else if (action === 'disconnect') {
    console.log(contextId + " telling " + peripheral.pCounter + " / " + peripheral.advertisement.localName + " to disconnect");
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
  //console.log("wiping listeners from " + peripheral.uuid + " / " + peripheral.contextId + " / " + andThisToo);
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
  //console.log("wiped listeners from " + peripheral.uuid + " / " + andThisToo);
}


noble.on('discover', function (peripheral) {

  console.log("noticed ", peripheral.uuid, " with ", peripheral.advertisement.serviceUuids.length, " services");
  assert(peripheral.advertisement.serviceUuids.length > 0, "gotta have services!");
  if(mapNoticedPeripherals[peripheral.uuid]) {
    const oldPeriph = mapNoticedPeripherals[peripheral.uuid];
    oldPeriph.tmNow = new Date().getTime();
  } else {
    mapNoticedPeripherals[peripheral.uuid] = new NoticedPeripheral(peripheral, new Date().getTime());
  }

  handleDiscoveredPeripheral(peripheral);
});

