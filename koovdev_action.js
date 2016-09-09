/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 */

'use strict';
let debug = require('debug')('koovdev_action');

const clamp = (min, max, value) => {
  return Math.max(min, Math.min(max, value));
};

const START_SYSEX = 0xF0;
const END_SYSEX = 0xF7;

/*
 * Pre-defined device actions.
 */
function D(pin) { return pin + 8; }
var KOOV_PORTS = {
  /*
   * by LED name
   */
  LED_LIVE: D(0),               // LED7
  LED_STANDALONE: D(1),         // LED8
  LED_R: D(13),                 // LED5
  LED_G: D(12),                 // LED5
  LED_B: D(10),                 // LED5
  LED_FET: D(18),
  LED_USB: D(20),               // LED3
  LED_BT: D(21),                // LED6
  LED_RX: D(30),                // LED2
  LED_TX: D(31),                // LED1

  /*
   * Followings are core buttons.  The port assigns are same as K2 .. K5.
   */
  A0: 0,                        // K2
  A1: 1,                        // K3
  A2: 2,                        // K4
  A3: 3,                        // K5

  /*
   * by user pin name
   */
  V0: [D(4) /* analog port */, D(5) /* digital port */],
  V1: [D(12) /* analog port */, D(10) /* digital port */],
  V2: D(2),
  V3: D(3),
  V4: D(6),
  V5: D(7),
  V6: D(8),
  V7: D(9),
  V8: D(11),
  V9: D(13),

  /*
   * (mostly) analog ports.
   */
  K0: [],
  K1: [],
  K2: 0,
  K3: 1,
  K4: 2,
  K5: 3,
  K6: 4,
  K7: 5,
};

/*
 * Multi LED state.
 */
var RGB_STATE = [
  { pin: KOOV_PORTS['LED_R'], state: false },
  { pin: KOOV_PORTS['LED_G'], state: false },
  { pin: KOOV_PORTS['LED_B'], state: false }
];

/*
 * Turn FET on if some of R/G/B LEDs are on.
 */
function turn_fet(board, pin, on) {
  var rgb = RGB_STATE.find(x => { return x.pin === pin; });
  if (rgb) {
    var fet = KOOV_PORTS['LED_FET'];
    rgb.state = on;
    if (RGB_STATE.some(x => { return x.state; })) {
      board.digitalWrite(fet, board.LOW); // turn on FET
    } else {
      board.digitalWrite(fet, board.HIGH); // turn off FET
    }
  }
}

/*
 * DC Motor state management.
 */
const analogMax = 255;
let DCMOTOR_STATE = [
  { port: 'V0', power: 0, mode: 'COAST' },
  { port: 'V1', power: 0, mode: 'COAST' }
];
const DCMOTOR_MODE = {
  NORMAL: (board, pins, power) => {
    board.digitalWrite(pins[1], board.LOW);
    board.analogWrite(pins[0], power);
  },
  REVERSE: (board, pins, power) => {
    board.digitalWrite(pins[1], board.HIGH);
    board.analogWrite(pins[0], analogMax - power);
  },
  COAST: (board, pins, power) => {
    board.digitalWrite(pins[1], board.LOW);
    board.analogWrite(pins[0], 0);
  },
  BRAKE: (board, pins, power) => {
    board.digitalWrite(pins[1], board.HIGH);
    board.analogWrite(pins[0], analogMax);
  }
};

function dcmotor_state(port) {
  return DCMOTOR_STATE.find(x => { return x.port === port; });
}

function dcmotor_control(board, port, power, mode) {
  let dm = dcmotor_state(port);
  if (dm) {
    var pins = KOOV_PORTS[port];
    if (power !== null)
      dm.power = power;
    if (mode !== null)
      dm.mode = mode;
    DCMOTOR_MODE[dm.mode](board, pins, dm.power);
  }
}
function dcmotor_power(board, port, power) {
  power = clamp(0, 100, power);
  power = Math.floor(power * analogMax / 100);
  dcmotor_control(board, port, power, null);
}
function dcmotor_mode(board, port, mode) {
  dcmotor_control(board, port, null, mode);
}

/*
 * Servomotor state management. 
 */
let SERVOMOTOR_STATE = {
  synchronized: false,
  expected_degree: {},
  current_degree: {},
  delta: {}
};
let SERVOMOTOR_DEGREE = {
};

const servoWrite = (board, pin, degree) => {
  SERVOMOTOR_DEGREE[pin] = degree;
  board.servoWrite(pin, degree);
};

const servoRead = (board, pin) => {
  return SERVOMOTOR_DEGREE[pin];
};

/*
* Buzzer operations.
 */
const buzzer_on = (board, pin, frequency) => {
  debug(`buzzer-on: pin: ${pin} freq ${frequency}`);
  board.transport.write(new Buffer([
    START_SYSEX, 0x0f, pin, 1, frequency, END_SYSEX
  ]));
};

const buzzer_off = (board, pin) => {
  debug(`buzzer-off: pin: ${pin}`);
  board.transport.write(new Buffer([
    START_SYSEX, 0x0f, pin, 0, 0, END_SYSEX
  ]));
};

/*
 * Generate action dispatch table for KOOV.
 */
function koov_actions(board) {
  const null_scaler = (value) => { return value; };
  const analog_scaler = (value) => {
    const in_min = 0;
    const in_max = 1023;
    const out_min = 0;
    const out_max = 100;
    return (value - in_min) * (out_max - out_min) /
      (in_max - in_min) + out_min;
  };
  var reporter = (type, enabler, initializer, scaler) => {
    return function(block, arg, cb) {
      var pin = KOOV_PORTS[block.port];
      if (typeof pin === 'number') {
        this.callback[type][pin] = v => {
          enabler(v.pin, 0);
          this.callback[type][pin] = null;
          const value = scaler(v.value);
          debug(`${type}: pin: ${pin}/${v.pin} value: ${value} (${v.value})`);
          cb({ error: false, value: value });
        };
        initializer(pin);
        enabler(pin, 1);
      } else {
        debug(`${type}: pin is not number`, pin, block);
        cb({ error: true, msg: `${type}: pin is not number`, value: 0 });
      }
    };
  };
  var analog_reporter = (initializer) => {
    return reporter('analog-read', (pin, on) => {
      board.reportAnalogPin(pin, on);
    }, initializer, analog_scaler);
  };
  var digital_reporter = (initializer) => {
    return reporter('digital-read', (pin, on) => {
      board.reportDigitalPin(pin, on);
    }, initializer, null_scaler);
  };
  let noreply = action => {
    return (block, arg, cb) => {
      action(block, arg);
      //debug(`${block.name}: call callback`);
      cb(null);
    };
  };

  const init_output = port => {
    const pin = KOOV_PORTS[port];
    board.pinMode(pin, board.MODES.OUTPUT);
    board.digitalWrite(pin, board.HIGH);
  };
  const low_output = port => {
    const pin = KOOV_PORTS[port];
    debug(`set pin ${pin} to low`);
    board.pinMode(pin, board.MODES.OUTPUT);
    board.digitalWrite(pin, board.LOW);
  };
  const init_input = port => {
    const pin = KOOV_PORTS[port];
    board.pinMode(pin, board.MODES.INPUT);
  };
  const init_button = port => {
    const pin = KOOV_PORTS[port];
    board.pinMode(pin, board.MODES.INPUT_PULLUP);
  };
  const init_sensor = port => {
    const pin = KOOV_PORTS[port];
    board.pinMode(pin, board.MODES.INPUT);
  };
  const init_servo = port => {
    const pin = KOOV_PORTS[port];
    debug(`init_servo: pin: ${pin} name: ${port}: servo`);
    //board.pinMode(pin, board.MODES.SERVO);
    board.servoConfig(pin, 500, 2500);
    servoWrite(board, pin, 90);
  };
  const init_dcmotor = port => {
    debug(`init_dcmotor: port ${port}`);
    const dm = dcmotor_state(port);
    if (dm) {
      const pins = KOOV_PORTS[port];
      debug(`init_dcmotor: pins ${pins[0]} ${pins[1]}`);
      board.pinMode(pins[1], board.MODES.OUTPUT);
      board.pinMode(pins[0], board.MODES.PWM);
      dcmotor_control(board, port, 0, 'COAST');
    }
  };
  const init_accel = port => {
    debug(`init_accel: port ${port}`);
    // XXX not yet implemented.
  };
  const init_buzzer = port => {
    const pin = KOOV_PORTS[port];
    buzzer_off(board, pin);
  };
  const initializer = {
    'output': low_output,
    'input': init_input,

    'led': low_output,
    'dc-motor': init_dcmotor,
    'servo-motor': init_servo,
    'buzzer': init_buzzer,
    'light-sensor': init_sensor,
    'touch-sensor': init_sensor,
    'sound-sensor': init_sensor,
    'ir-photo-reflector': init_sensor,
    '3-axis-digital-accelerometer': init_accel,
    'push-button': init_button
  };

  return {
    action_queue: [],
    action_id: 0,
    current_action: null,
    resetting: false,
    reset: function() {
      debug('reset:', this.current_action);
      this.resetting = true;
      if (this.current_action) {
        const { block: block, arg: arg, finish: finish } = this.current_action;
        debug('call finish: resetting');
        return finish({ msg: 'action terminated'});
      }
    },
    action: function(block, arg, cb) {
      const push_action = (block, arg, cb) => {
        const id = this.action_id++;
        const finish = (err) => {
          if (this.current_action === null)
            return;
          // try { let a = {}; a.debug(); } catch (ex) { debug(ex.stack); }
          // debug('finish: id', this.current_action.id, id);
          if (this.current_action.id != id) {
            debug('finish: id mismatch', this.current_action.id, id);
            debug('finish: expect', e);
            debug('finish: current', this.current_action);
            return;
          }
          setImmediate(() => { this.current_action = null; return exec(); });
          return cb(err);
        };
        const e = { block: block, arg: arg, finish: finish, id: id };
        this.action_queue.push(e);
      };
      const exec = () => {
        if (this.current_action !== null ||
            this.action_queue.length === 0)
          return;

        this.current_action = this.action_queue.pop();
        const { block: block, arg: arg, finish: finish } = this.current_action;
        if (this.resetting) {
          debug('call finish: resetting');
          return finish({ msg: 'action terminated'});
        }

        if (this[block.name]) {
          try {
            return this[block.name](block, arg, (err) => {
              //debug('call finish: block callback', err, block);
              return finish(err);
            });
          } catch (e) {
            debug('call finish: exception', e);
            return finish(e);
          }
        }
        debug('call finish: no such block');
        return finish({ msg: `no such block ${block.name}`});
      };
      push_action(block, arg, cb);
      return exec();
    },
    // callbacks by pin number.
    callback: {
      'analog-read': {},
      'digital-read': {},
      'accelerometer-read': null,
      'bts01-cmd': null
    },
    'port-settings': function(block, arg, cb) {
      const port_settings = block['port-settings'];
      debug('port-settings', port_settings);
      board.reset();
      // Removing this if guard prevented servo motor from initializing.
      if (port_settings['RGB'] || true) {
        debug(`setting multi-led`);
        ['LED_R', 'LED_G', 'LED_B', 'LED_FET'].forEach(x => {
          board.pinMode(KOOV_PORTS[x], board.MODES.OUTPUT);
          board.digitalWrite(KOOV_PORTS[x], board.HIGH);
        });
      }
      ['V0', 'V1'].forEach(port => {
        if (port_settings[port])
          init_dcmotor(port);
      });
      ['V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'].forEach(port => {
        debug(`setting port ${port}`);
        (initializer[port_settings[port] || 'output'])(port);
      });
      ['K2', 'K3', 'K4', 'K5', 'K6', 'K7'].forEach(port => {
        debug(`setting port ${port}`);
        (initializer[port_settings[port] || 'input'])(port);
      });
      debug(`done setting port`);
      return cb();
    },
    'board-init': function(block, arg, cb) {
      debug(`board-init: init led`);
      // [
      //   'LED_LIVE', 'LED_STANDALONE', 'LED_USB', 'LED_BT',
      //   'LED_R', 'LED_G', 'LED_B', 'LED_FET',
      //   'LED_RX', 'LED_TX'
      // ].forEach(init_output);
      // debug(`board-init: init analog port`);
      // ['K2', 'K3', 'K4', 'K5', 'K6', 'K7'].forEach(init_button);
      // debug(`board-init: init digital port`);
      // ['V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'].forEach(init_output);
      // debug(`board-init: init listener`);
      ['digital-read', 'analog-read'].forEach(type => {
        board.addListener(type, v => {
          var callback = this.callback[type][v.pin];
          if (callback) {
            callback(v);
          }
        });
      });
      board.addListener('accelerometer-read', v => {
        var callback = this.callback['accelerometer-read'];
        if (callback) {
          callback(v);
        }
      });
      board.addListener('bts01-cmd', v => {
        var callback = this.callback['bts01-cmd'];
        debug('bts01-cmd', v);
        if (callback) {
          callback(v);
        }
      });
      cb();
    },
    'turn-led': noreply(block => {
      var pin = KOOV_PORTS[block.port];
      if (typeof pin === 'number') {
        var on = block.mode === 'ON';
        turn_fet(board, pin, on);
        board.digitalWrite(pin, on ? board.HIGH : board.LOW);
      }
    }),
    'multi-led': noreply(block => {
      let r = block.r, g = block.g, b = block.b;
      debug(`multi-led: ${r}, ${g}, ${b}`, block);
      if (typeof r === 'number' &&
          typeof g === 'number' &&
          typeof b === 'number') {
        let fet = KOOV_PORTS['LED_FET'];
        if (r === 0 && g === 0 && b === 0) {
          debug(`multi-led: set ${fet} to HIGH`);
          board.digitalWrite(fet, board.HIGH); // turn off FET
          RGB_STATE.forEach(x => {
            x.state = false;
            debug(`multi-led: set ${x.pin} to HIGH`);
            board.digitalWrite(x.pin, board.HIGH); // turn off
          });
        } else {
          debug(`multi-led: set ${fet} to LOW`);
          board.digitalWrite(fet, board.LOW); // turn on FET
          [r, g, b].forEach((x, idx) => {
            let power = clamp(0, 100, x) * 255 / 100;
            power = Math.floor(power);
            RGB_STATE[idx].state = true;
            debug(`multi-led: set ${RGB_STATE[idx].pin} to ${power}`);
            board.pinMode(RGB_STATE[idx].pin, board.MODES.PWM);
            board.digitalWrite(RGB_STATE[idx].pin,
                               power === 0 ? board.HIGH : board.LOW);
            board.analogWrite(RGB_STATE[idx].pin, 255 - power);
          });
        }
      }
    }),
    'buzzer-on': noreply(block => {
      const pin = KOOV_PORTS[block.port];
      if (typeof pin === 'number') {
        buzzer_on(board, pin, block.frequency);
      }
    }),
    'buzzer-off': noreply(block => {
      const pin = KOOV_PORTS[block.port];
      if (typeof pin === 'number') {
        buzzer_off(board, pin);
      }
    }),
    'servomotor-synchronized-motion': (block, arg, cb) => {
      const all_ports = () => {
        return Object.keys(SERVOMOTOR_STATE.expected_degree);
      };
      const max_delta = () => {
        return all_ports().reduce((acc, port) => {
          const pin = KOOV_PORTS[port];
          const degree = SERVOMOTOR_STATE.expected_degree[port];
          const curdeg = servoRead(board, pin);
          const delta = degree - curdeg;
          debug('max_delta', port, degree, curdeg, delta);
          SERVOMOTOR_STATE.current_degree[port] = curdeg;
          SERVOMOTOR_STATE.delta[port] = delta;
          return Math.abs(delta) > acc ? Math.abs(delta) : acc;
        }, 0);
      };
      const move_nodelay = (max_delta, cb) => {
        all_ports().forEach(port => {
          const pin = KOOV_PORTS[port];
          const degree = SERVOMOTOR_STATE.expected_degree[port];
          servoWrite(board, pin, degree);
        });
        setTimeout(() => { cb(null); }, max_delta * 3);
      };
      const move_withdelay = (max_delta, cb, delay) => {
        all_ports().forEach(port => {
          const delta = SERVOMOTOR_STATE.delta[port];
          SERVOMOTOR_STATE.delta[port] = delta / max_delta;
        });
        let count = 0;
        const loop = () => {
          count++;
          all_ports().forEach(port => {
            const pin = KOOV_PORTS[port];
            const delta = SERVOMOTOR_STATE.delta[port];
            const curdeg = SERVOMOTOR_STATE.current_degree[port];
            servoWrite(board, pin, curdeg + delta * count);
          });
          if (count < max_delta)
            setTimeout(() => { return loop(); }, delay);
          else
            setTimeout(() => { return cb(null); }, delay);
        };
        return loop();
      };
      if (arg) {
        var v = arg;
        debug('servomotor-synchronized-motion[after]: ', v,
              SERVOMOTOR_STATE.expected_degree);
        SERVOMOTOR_STATE.synchronized = false;
        const delay = 20 - clamp(0, 20, v.speed);
        const delta = max_delta();
        if (delta == 0)
          return cb(null);
        if (delay === 0)
          return move_nodelay(delta, cb);
        return move_withdelay(delta, cb, delay);
      } else {
        debug('servomotor-synchronized-motion[before]: ', arg);
        SERVOMOTOR_STATE.synchronized = true;
        SERVOMOTOR_STATE.expected_degree = {};
        SERVOMOTOR_STATE.current_degree = {};
        SERVOMOTOR_STATE.delta = {};
        return cb(null);
      }
    },
    'set-servomotor-degree': noreply(block => {
      const port = block.port;
      const degree = clamp(0, 180, block.degree);
      var pin = KOOV_PORTS[port];
      if (typeof pin === 'number') {
        if (SERVOMOTOR_STATE.synchronized) {
          debug(`set-servomotor-degree: port: ${port} degree: ${degree}`);
          SERVOMOTOR_STATE.expected_degree[port] = degree;
        } else {
          debug(`set-servomotor-degree: pin: ${pin} degree: ${degree}`);
          servoWrite(board, pin, degree);
        }
      }
    }),
    'set-dcmotor-power': noreply(block => {
      dcmotor_power(board, block.port, block.power);
    }),
    'turn-dcmotor-on': noreply(block => {
      dcmotor_mode(board, block.port, block.direction);
    }),
    'turn-dcmotor-off': noreply(block => {
      dcmotor_mode(board, block.port, block.mode);
    }),
    'button-value': digital_reporter(pin => {
      board.pinMode(pin, board.MODES.INPUT_PULLUP);
    }),
    'touch-sensor-value': digital_reporter(pin => {
      board.pinMode(pin, board.MODES.INPUT);
    }),
    'ir-photo-reflector-value': analog_reporter(pin => {
      board.pinMode(pin, board.MODES.INPUT);
    }),
    'light-sensor-value': analog_reporter(pin => {
      board.pinMode(pin, board.MODES.INPUT);
    }),
    'sound-sensor-value': analog_reporter(pin => {
      board.pinMode(pin, board.MODES.INPUT);
    }),
    '3-axis-digital-accelerometer-value': function(block, arg, cb) {
      const port = block.port;
      if (port === 'K0' || port === 'K1') {
        const type = 'accelerometer-read';
        this.callback[type] = v => {
          this.callback[type] = null;
          const value = v.value;
          debug(`${type}: port: ${port} value: ${value} (${v.value})`);
          cb({ error: false, value: value });
        };
        const direction =
              block.direction === 'x' ? 0x01 :
              block.direction === 'y' ? 0x02 : 0x03;
        board.transport.write(new Buffer([
          START_SYSEX, 0x0e, 0x01, direction, END_SYSEX
        ]));
      } else
        cb({ error: true, msg: `${type}: unknown port ${port}`, value: 0 });
    },
    'bts01-reset': function(block, arg, cb) {
      board.transport.write(new Buffer([
        START_SYSEX, 0x0e, 0x02, 0x01, END_SYSEX
      ]), (err) => {
        debug('board.transport.write callback: bts01-reset:', err);
        cb(null);
      });
    },
    'bts01-cmd': function(block, arg, cb) {
      debug('bts01-cmd', arg);
      const timeout = arg.timeout || 1000;
      const cmd = Buffer.concat([
        new Buffer([
          START_SYSEX, 0x0e, 0x02, 0x02,
          (timeout >> 7) & 0x7f, timeout & 0x7f
        ]),
        new Buffer(arg.command),
        new Buffer([END_SYSEX])
      ]);
      const type = 'bts01-cmd';
      this.callback[type] = v => {
        this.callback[type] = null;
        debug(`${type}:`, v);
        v.error = null;
        cb(v);
      };
      board.transport.write(cmd, (err) => {
        debug('board.transport.write callback: bts01-cmd:', err);
        if (err) {
          this.callback[type] = null;
          cb({ error: err });
        }
      });
    },
    'koov-reset': function(block, arg, cb) {
      debug('koov-reset', arg);
      const ticks = arg.ticks || 1000;
      board.transport.write(new Buffer([
        START_SYSEX, 0x0e, 0x02, 0x03,
        (ticks >> 7) & 0x7f, ticks & 0x7f,
        END_SYSEX
      ]), (err) => {
        debug('board.transport.write callback: koov-reset:', err);
        cb(null);
      });
    },
    'firmata-version': function(block, arg, cb) {
      debug('firmata-version', arg);
      cb({ error: null, version: board.firmware.version });
    },
    'firmata-name': function(block, arg, cb) {
      debug('firmata-name', arg);
      cb({ error: null, name: board.firmware.name });
    }
  };
};

const open_firmata = (action, cb, opts) => {
  debug('firmata open');
  let called = false;
  const callback = (err) => {
    if (called)
      return;
    called = true;
    clearTimeout(timeoutId);
    return cb(err);
  };
  const timeoutId = setTimeout(() => {
    return callback('failed to open firmata');
  }, 10000);
  const firmata = require('firmata');
  const transport = {
    write: (data, cb) => {
      //debug('transport: write', data);
      return action.device.serial_write(data, (err) => {
        //debug('transport: write', err);
        if (cb)
          return cb(err);
      });
    },
    on: (what, cb) => {
      //debug('transport: on', what);
      return action.device.serial_event(what, (err) => {
        //debug('transport: on', err);
      }, cb);
    }
  };
  const board = new firmata.Board(transport, opts, (err) => {
    debug('firmata open', err);
    if (err)
      return callback(err);
    const keep_alive = () => {
      action.keepAliveId = setTimeout(() => {
        if (!action.device) {
          debug('keep_alive: stop');
          action.keepAliveId = null;
          return;
        }
        board.reportVersion(() => {
          //debug('keep_alive: version reported');
          keep_alive();
        });
      }, 5 * 1000);
    };
    action.action['board-init'](null, null, callback);
    keep_alive();
  });
  action.board = board;
  action.action = koov_actions(board);
};

function Action(opts)
{
  this.board = null;
  this.action = null;
  this.keepAliveId = null;
  this.device = opts.device;
  if (opts.debug)
    debug = opts.debug;
  const termiate_device = () => {
    if (!this.device)
      return;
    debug('terminating device');
    this.device.terminate(() => {
      this.close((err) => {
        debug('action: disconnected: close completed', err);
      });
    });
  };
  const on_disconnect = () => {
    debug('action: disconnected', this.device);
    termiate_device();
  };
  const on_error = (err) => {
    debug('action: error', err);
    if (err)
      termiate_device();
  };
  const on_close = (err) => {
    debug('action: close', err);
    if (err)
      termiate_device();
  };
  this.open = function(name, cb) {
    debug('action: open', name);
    if (!this.device)
      return cb('action: no serial');
    this.device.open(name, (err) => {
      debug('action: serial: open', err);
      if (err)
        return cb(err);
      return open_firmata(this, (err) => {
        if (err)
          return cb(err);
        this.board.on('disconnect', on_disconnect);
        this.board.on('error', on_error);
        this.board.on('close', on_close);
        return cb(null);
      }, {
        reportVersionTimeout: 0,
        //reportVersionTimeout: 5000,
        //samplingInterval: 10000
      });
    });
  };
  this.close = function(cb) {
    debug('action: close');
    if (this.keepAliveId) {
      debug('close: clear keep alive timer');
      clearTimeout(this.keepAliveId);
      this.keepAliveId = null;
    }
    if (this.action)
      this.action.reset();
    return this.device.close(cb);
  };
};

module.exports = {
  action: (opts) => { return new Action(opts); }
};
