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

async.waterfall([
  (done) => {
    device.device_scan(done);
  },
  (done) => {
    device.list((list) => {
      console.log(list);
      const usb = list.find(x => x.type === 'usb');
      if (!usb)
        return done('no usb device');
      return done(null, usb);
    });
  },
  (usb, done) => {
    koovdev_action.open(usb, done);
  },
  (done) => {
    console.log(`issue firmata-version`);
    koovdev_action.action.action({ name: 'firmata-version' }, null, (v) => {
      console.log(`firmata-version`, v);
      done(v.error);
    });
  },
  (done) => {
    console.log(`issue firmata-name`);
    koovdev_action.action.action({ name: 'firmata-name' }, null, (v) => {
      console.log(`firmata-version`, v);
      done(v.error);
    });
  },
  (done) => {
    console.log(`issue bts01-reset`);
    koovdev_action.action.action({ name: 'bts01-reset' }, null, done);
  },
  build_cmd('AT+XYZ\r'),
  build_cmd('AT+RVN\r'),
  build_cmd('AT+RBA\r'),
  build_cmd('AT+RBI\r'),
  build_cmd('AT+SBO\r'),
  (done) => {
    setTimeout(() => {
      koovdev_action.close((err) => {
        console.log('close', err);
        done();
      });
    }, 5000);
  }
]);
