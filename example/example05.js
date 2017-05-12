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
    console.log(`firmata-name`, v);
    done(v.error);
  });
};

const btpin_exists = (done) => {
  console.log(`issue btpin-exists?`);
  koovdev_action.action.action({ name: 'btpin' }, {
    command: [ 0x02 ]
  }, (v) => {
    console.log(`btpin-exists?`, v);
    done(v.error);
  });
};

const btpin_write = (done) => {
  console.log(`issue btpin-write`);
  koovdev_action.action.action({ name: 'btpin' }, {
    command: [ 0x00, 0x52, 0x09 ]
  }, (v) => {
    console.log(`btpin-write`, v);
    done(v.error);
  });
};

const btpin_verify = (btpin) => (done) => {
  console.log(`issue btpin-verify ${btpin}`);
  koovdev_action.action.action({ name: 'btpin' }, {
    command: [ 0x01, btpin & 0x7f, ((btpin >> 7) & 0x7f) ]
  }, (v) => {
    console.log(`btpin-verify ${btpin}`, v);
    done(v.error);
  });
};

const flash_write = (done) => {
  console.log(`issue flash write`);
  const biltrans = '../../biltrans';
  const bilbinary = require(`../../bilbinary/bilbinary`);
  const scripts2 = require(`${biltrans}/example/rr_recorder.json`);
  //const scripts2 = require(`${biltrans}/example/empty2.json`);
  const trans = bilbinary.translator(scripts2);
  koovdev_action.clear_keep_alive();
  koovdev_action.action.action({ name: 'flash-write' }, {
    data: trans.translate(),
    progress: () => {},
  }, (v) => {
    console.log(`firmata-name`, v);
    done(v.error);
  });
};

let selected_device = null;
const device_select = (done) => {
  device.list((list) => {
    console.log(list);
    const dev = list.find(x => x.type === 'usb');
    //const dev = list.find(x => x.uuid === '33c493e7cced46f89b48fc1db7ae8157');
    //const dev = list.find(x => x.uuid === '8d8c74220dd946fdb817c8d8df509897');
    if (!dev)
      return done('no device');
    selected_device = dev;
    return done(null, dev);
  });
};

const bts01_cmd = (name, command) => {
  return (done) => {
    console.log(`issue bts01-cmd: ${JSON.stringify(command)}`);
    koovdev_action.action.action({ name: name }, {
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
};

const bts01_reset = bts01_cmd('bts01-reset',
                              'AT+RVN\rAT+CCP=0008,0008,0001,0190\r');
const bts01_getname = bts01_cmd('bts01-cmd', 'AT+CDN\r');
const bts01_setname = (name) => {
  return bts01_cmd('bts01-cmd', `AT+CDN=${name}\r`);
};

async.waterfall([
  (done) => {
    device.device_scan(done);
  },
  device_select,
  (dev, done) => {
    koovdev_action.open(dev, done);
  },
  firmata_name,
  firmata_version,
  btpin_exists,
  btpin_write,
  btpin_verify(1233),
  btpin_verify(1234),
  btpin_verify(1235),
  btpin_exists,
  (done) => {
    setTimeout(() => {
      koovdev_action.close((err) => {
        console.log('close', err);
        done();
      });
    }, 200);
  }
], (err, result) => {
  console.log('all done', err, result);
  process.exit(0);
});
