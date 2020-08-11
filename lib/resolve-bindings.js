const os = require('os');

module.exports = function () {
  const platform = os.platform();

  if (process.env.NOBLE_WEBSOCKET) {

    //console.log("bound to websocket");
    return require('./websocket/bindings');

  } else if (process.env.NOBLE_DISTRIBUTED) {

    //console.log("bound to distributed");
    return require('./distributed/bindings');

  } else if (platform === 'darwin') {

    //console.log("bound to mac");
    return require('./mac/bindings');

  } else if (platform === 'linux' || platform === 'freebsd' || platform === 'win32') {

    //console.log("bound to hci-socket");
    return require('./hci-socket/bindings');

  } else {
    throw new Error('Unsupported platform');
  }
};
