/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 */

'use strict';
let debug = require('debug')('test');
const async = require('async');

const device_proxy = require('device_proxy');
let ipc = { request: {}, reply: {} };
const opts = {
  sender: (to, what) => { return ipc.request[to](to, what); },
  listener: (to, cb) => {
    ipc.reply[to] = (event, arg) => { return cb(arg); };
  }
};

const device = device_proxy.client(opts);
const koovdev_action = require('../koovdev_action.js').action({
  device: device
});

let koovdev_device = require('koovdev_device');
let server = device_proxy.server({
  listener: (from, handler) => {
    ipc.request[from] = (event, arg) => {
      return handler((to, what) => {
        return ipc.reply[to](to, what);
      }, arg);
    };
  },
  device: koovdev_device.device()
});

const build_cmd = (cmd) => {
  return (done) => {
    if (selected_device.type !== 'usb')
      return done();
    console.log(`bts01-cmd: ${cmd}`);
    koovdev_action.action.action({ name: 'bts01-cmd' }, {
      timeout: 1000,
      command: cmd
    }, (v) => {
      console.log(`error => `, v.error);
      if (!v.error) {
        const s = new Buffer(v.buffer).toString();
        // console.log(s);
        console.log(s.split(/[\r\n]/).reduce((acc, x) => {
          if (x.length > 0)
            acc.push(x);
          return acc;
        }, []).reverse());
      }
      done();
    });
  };
};

const firmata_version = (done) => {
  console.log(`issue firmata-version`);
  koovdev_action.action.action({ name: 'firmata-version' }, null, (v) => {
    console.log(`firmata-version`, v);
    done(v.error);
  });
};

const firmata_name = (done) => {
  console.log(`issue firmata-name`);
  koovdev_action.action.action({ name: 'firmata-name' }, null, (v) => {
    console.log(`firmata-version`, v);
    done(v.error);
  });
};

let selected_device = null;
const device_select = (done) => {
  device.list((list) => {
    console.log(list);
    //const dev = list.find(x => x.type === 'usb');
    const dev = list.find(x => x.uuid === '33c493e7cced46f89b48fc1db7ae8157');
    if (!dev)
      return done('no device');
    selected_device = dev;
    return done(null, dev);
  });
};

const bts01_reset = (done) => {
  const command = 'AT+RVN\rAT+CCP=0007,0007,0001,0190\r';
  console.log(`issue bts01-reset: ${JSON.stringify(command)}`);
  koovdev_action.action.action({ name: 'bts01-reset' }, {
    command: command
  }, (v) => {
    console.log(`error =>`, v.error);
    if (!v.error) {
      const s = new Buffer(v.buffer).toString();
      console.log(JSON.stringify(s));
      done();
    } else {
      setTimeout(() => {
        koovdev_action.close((err) => {
          console.log('close', err);
          koovdev_action.open(selected_device, done);
        });
      }, 100);
    }
  });
};

async.waterfall([
  (done) => {
    device.device_scan(done);
  },
  device_select,
  (dev, done) => {
    koovdev_action.open(dev, done);
  },
  firmata_version,
  firmata_name,
  bts01_reset,
  build_cmd('AT+XYZ\r'),
  build_cmd('AT+RVN\r'),
  build_cmd('AT+RBA\r'),
  build_cmd('AT+RBI\r'),
  build_cmd('AT+CCP\r'),
/**/
//  build_cmd('AT+CCP=0007,0007,0001,0190\r'),
  build_cmd('AT+CCP=0006,000c,0001,0190\r'),
  build_cmd('AT+CCP\r'),
/**/
  build_cmd('AT+SBO\r'),
  firmata_version,
  firmata_name,
/*
  (done) => {
    console.log(`issue koov-reset`);
    koovdev_action.action.action({ name: 'koov-reset' }, {
      ticks: 5000
    }, done);
  },
*/
  (done) => {
    setTimeout(() => {
      koovdev_action.close((err) => {
        console.log('close', err);
        done();
      });
    }, 5000);
  }
], (err, result) => {
  console.log('all done', err, result);
  process.exit(0);
});
