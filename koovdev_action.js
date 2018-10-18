/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * 
 * Copyright (c) 2017 Sony Global Education, Inc.
 * 
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 * BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

'use strict';
let debug = require('debug')('koovdev_action');
const koovdev_error = require('koovdev_error');

const KOOVDEV_ACTION_ERROR = 0xfb;

const ACTION_NO_ERROR = 0x00;
const ACTION_TERMINATED = 0x01;
const ACTION_EXCEPTION = 0x02;
const ACTION_UNKNOWN_BLOCK = 0x03;
const ACTION_UNKNOWN_PORT = 0x04;
const ACTION_BTS01CMD_FAILURE = 0x05;
const ACTION_OPEN_FIRMATA_TIMEDOUT = 0x06;
const ACTION_OPEN_FIRMATA_FAILURE = 0x07;
const ACTION_WRITE_ERROR = 0x08;
const ACTION_NO_DEVICE = 0x09;
const ACTION_TIMEOUT = 0x0a;
const ACTION_FLASH_ERASE_FAILURE = 0x0b;
const ACTION_FLASH_WRITE_FAILURE = 0x0c;
const ACTION_FLASH_FINISH_FAILURE = 0x0d;
const ACTION_BTPIN_FAILURE = 0x0e;
const ACTION_FIRMATA_VERSION_MISMATCH = 0x0f;

const ACTION_REQUIRED_FIRMATA_VERSION = 3; // required firmata major version

const ACTION_BTPIN_PROBE = 0x3ffd;
const ACTION_BTPIN_NULL = 0x3ffe;

const { error, error_p, make_error } = koovdev_error(KOOVDEV_ACTION_ERROR, [
  ACTION_NO_ERROR
]);

const clamp = (min, max, value) => {
  return Math.max(min, Math.min(max, value));
};
const to_integer = (x) => Math.floor(Number(x));

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
 * DC Motor correction.
 */

const RPM_TABLE = {
  NORMAL: [
    { power: 0, rpm: 0 },
    { power: 10, rpm: 0 },
    { power: 20, rpm: 10.44 },
    { power: 30, rpm: 25.51 },
    { power: 40, rpm: 35.60 },
    { power: 50, rpm: 45.32 },
    { power: 60, rpm: 49.12 },
    { power: 70, rpm: 53.19 },
    { power: 80, rpm: 56.02 },
    { power: 90, rpm: 58.43 },
    { power: 100, rpm: 60.05 },
  ],
  REVERSE: [
    { power: 0, rpm: 0 },
    { power: 10, rpm: 0 },
    { power: 20, rpm: 6.34 },
    { power: 30, rpm: 17.78 },
    { power: 40, rpm: 22.87 },
    { power: 50, rpm: 23.89 },
    { power: 60, rpm: 29.54 },
    { power: 70, rpm: 35.46 },
    { power: 80, rpm: 43.94 },
    { power: 90, rpm: 52.59 },
    { power: 100, rpm: 60.32 },
  ]
};
const DCMOTOR_RPM_MAX = 60;
const DCMOTOR_RPM_MIN = 20;
const DCMOTOR_POWER_SWITCH = 10;
const DCMOTOR_INITIAL_POWER = 30;

const INTERPOLATE = (x, minx, maxx, miny, maxy) => {
  return (maxy - miny) * (clamp(minx, maxx, x) - minx) / (maxx - minx) + miny;
};

var dcmotor_correction = true;
const dcmotor_correct = (power, direction) => {
  if (!dcmotor_correction)
    return power;

  const table = direction ? RPM_TABLE.NORMAL : RPM_TABLE.REVERSE;

  if (power < DCMOTOR_POWER_SWITCH) {
    const power_switch = dcmotor_correct(DCMOTOR_POWER_SWITCH, direction);
    return power_switch * power / DCMOTOR_POWER_SWITCH;
  }

  const rpm = INTERPOLATE(power, DCMOTOR_POWER_SWITCH, 100,
                          DCMOTOR_RPM_MIN, DCMOTOR_RPM_MAX);

  return table.slice(1).reduce((acc, cur, i) => {
    const prev = table[i];
    if (prev.rpm <= rpm && rpm <= cur.rpm)
      return INTERPOLATE(rpm, prev.rpm, cur.rpm, prev.power, cur.power);
    return acc;
  }, 0);
};

/*
 * DC Motor state management.
 */
const analogMax = 255;
let DCMOTOR_STATE = [
  { port: 'V0', power: DCMOTOR_INITIAL_POWER, mode: 'COAST', scale: 1 },
  { port: 'V1', power: DCMOTOR_INITIAL_POWER, mode: 'COAST', scale: 1 }
];
const DCMOTOR_MODE = {
  NORMAL: (board, pins, power) => {
    board.digitalWrite(pins[1], board.LOW);
    if (power > 0) {
      const opower = power;
      power = dcmotor_correct(power, true);
      debug(`set-dcmotor-power/normal: ${opower} -> ${power}`);
      power = power * analogMax / 100;
    }
    board.analogWrite(pins[0], to_integer(power));
  },
  REVERSE: (board, pins, power) => {
    board.digitalWrite(pins[1], board.HIGH);
    if (power > 0) {
      const opower = power;
      power = dcmotor_correct(power, false);
      debug(`set-dcmotor-power/reverse: ${opower} -> ${power}`);
      power = power * analogMax / 100;
    }
    board.analogWrite(pins[0], analogMax - to_integer(power));
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
    debug(`dcmotor_control: pin: ${pins} power ${dm.power}`);
    DCMOTOR_MODE[dm.mode](board, pins, dm.power * dm.scale);
  }
}
function dcmotor_power(board, port, power) {
  power = clamp(0, 100, power);
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
const SERVOMOTOR_DRIFT = {
};

const servoWrite = (board, pin, degree) => {
  debug(`servoWrite: pin: ${pin}`, degree);
  SERVOMOTOR_DEGREE[pin] = degree;
  degree += SERVOMOTOR_DRIFT[pin];
  board.servoWrite(pin, to_integer(clamp(0, 180, degree)));
};

const servoRead = (board, pin) => {
  return SERVOMOTOR_DEGREE[pin];
};

/*
 * Buzzer operations.
 */
const buzzer_on = (board, pin, frequency) => {
  frequency = to_integer(frequency);
  debug(`buzzer-on: pin: ${pin} freq ${frequency}`);
  board.transport.write(new Buffer([
    START_SYSEX, 0x0f, pin, 1, frequency, END_SYSEX
    //START_SYSEX, 0x0e, 0x02, 0x04, pin, 1, frequency, END_SYSEX
  ]));
};

const buzzer_off = (board, pin) => {
  debug(`buzzer-off: pin: ${pin}`);
  board.transport.write(new Buffer([
    START_SYSEX, 0x0f, pin, 0, 0, END_SYSEX
    //START_SYSEX, 0x0e, 0x02, 0x04, pin, 0, 0, END_SYSEX
  ]));
};

const play_melody = (board, pin, melody, old, cb) => {
  debug(`buzzer-on (melody): pin: ${pin}`, melody);
  board.transport.write(new Buffer([
    START_SYSEX, 0x0e, 0x02
  ].concat(old ? [
    0x06, pin
  ] : [
    0x0c
  ]).concat(melody.slice(0, 28).reduce((acc, x) => {
    const freq = to_integer(x.frequency);
    const tms = to_integer(x.secs * 1000 / 10);
    const valid_freq = freq => (48 <= freq && freq <= 108);

    if (!old) {
      const pin = KOOV_PORTS[x.port];
      acc.push(pin);
    }
    acc.push(((valid_freq(freq) ? freq - 47 : 0) << 1) | (tms > 0xff ? 1 : 0));
    acc.push((tms & 0xff) == END_SYSEX ? END_SYSEX + 1 : (tms & 0xff));
    return acc;
  }, []), END_SYSEX)), (err) => {
    debug('transport: write', err);
    return error(err ? ACTION_WRITE_ERROR : ACTION_NO_ERROR, err, cb);
  });
};

/*
 * Servomotor operations.
 */
const servomotor_synchronized_motion = (board, speed, degrees) => {
  debug(`servomotor_synchronized_motion:`, speed, degrees);
  const sync_params = Object.keys(degrees).reduce((acc, port) => {
    const pin = KOOV_PORTS[port];
    if (typeof pin !== 'number')
      return acc;
    return acc.concat(pin, clamp(0, 180, degrees[port]));
  }, []);
  board.transport.write(new Buffer([
    START_SYSEX, 0x0e, 0x02, 0x05, speed
  ].concat(sync_params.length / 2, sync_params, END_SYSEX)));
};

/*
 * Generate action dispatch table for KOOV.
 */
function koov_actions(board, action_timeout, selected_device) {
  const null_scaler = (value) => { return value; };
  const build_scaler = (in_min, in_max) => (value) => {
    const out_min = 0;
    const out_max = 100;
    return (value - in_min) * (out_max - out_min) /
      (in_max - in_min) + out_min;
  };
  const analog_scaler = build_scaler(0, 1023);
  const sound_scaler = build_scaler(0, 1023 * (3.3 - 1.5) / 3.3);
  var reporter = (type, enabler, initializer, scaler) => {
    return function(block, arg, cb) {
      const port = block.port;
      const pin = KOOV_PORTS[port];
      if (typeof pin === 'number') {
        this.callback[type][pin] = v => {
          enabler(v.pin, 0);
          this.callback[type][pin] = null;
          const value = scaler(v.value);
          debug(`${type}: pin: ${pin}/${v.pin} value: ${value} (${v.value})`);
          return error(ACTION_NO_ERROR, { error: false, value: value }, cb);
        };
        initializer(pin);
        enabler(pin, 1);
      } else {
        debug(`${type}: pin is not number`, pin, block);
        return error(ACTION_UNKNOWN_PORT, {
          msg: `${type}: ${port}: pin is not number`, value: 0
        }, cb);
      }
    };
  };
  var analog_reporter = (initializer, scaler) => {
    return reporter('analog-read', (pin, on) => {
      board.reportAnalogPin(pin, on);
    }, initializer, scaler);
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
      return error(ACTION_NO_ERROR, null, cb);
    };
  };
  const syncreply = action => {
    return (block, arg, cb) => {
      action(block, arg);
      //debug(`${block.name}: call callback`);
      board.reportVersion(() => {
        debug('sync-reply: report version done');
        return error(ACTION_NO_ERROR, null, cb);
      });
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
  const init_servo = (port, calib) => {
    const pin = KOOV_PORTS[port];
    debug(`init_servo: pin: ${pin} name: ${port}: servo`);
    if (calib && typeof calib.drift === 'number')
      SERVOMOTOR_DRIFT[pin] = calib.drift;
    else
      SERVOMOTOR_DRIFT[pin] = 0;
    //board.pinMode(pin, board.MODES.SERVO);
    board.servoConfig(pin, 500, 2500);
    servoWrite(board, pin, 90);
  };
  const init_dcmotor = (port, calib) => {
    debug(`init_dcmotor: port ${port}`);
    const dm = dcmotor_state(port);
    if (dm) {
      const pins = KOOV_PORTS[port];
      debug(`init_dcmotor: pins ${pins[0]} ${pins[1]}`);
      board.pinMode(pins[1], board.MODES.OUTPUT);
      board.pinMode(pins[0], board.MODES.PWM);
      dm.scale = calib && typeof calib.scale === 'number' ? carib.scale : 1;
      dm.scale = clamp(0, 1, dm.scale);
      dcmotor_control(board, port, DCMOTOR_INITIAL_POWER, 'COAST');
    }
  };
  const init_accel = port => {
    debug(`init_accel: port ${port}`);
    // XXX not yet implemented.
  };
  const init_buzzer = port => {
    const pin = KOOV_PORTS[port];
    board.pinMode(pin, board.MODES.PWM);
    buzzer_off(board, pin);
  };
  const init_multiled = port => {
    ['LED_R', 'LED_G', 'LED_B', 'LED_FET'].forEach(x => {
      board.pinMode(KOOV_PORTS[x], board.MODES.OUTPUT);
      board.digitalWrite(KOOV_PORTS[x], board.HIGH);
    });
  };
  const initializer = {
    'output': low_output,
    'input': init_input,

    'led': low_output,
    'multi-led': init_multiled,
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
  const ack_device = (tag, board, cb) => {
    return board.reportVersion(() => {
      debug(`${tag}: report version done`);
      return cb();
    });
  };
  const ack_noerror = (tag, board, cb) => {
    return ack_device(tag, board, () => {
      return error(ACTION_NO_ERROR, null, cb);
    });
  };

  return {
    action_queue: [],
    action_id: 0,
    current_action: null,
    resetting: false,
    pending_error: null,
    stop_melody: false,
    reset: function() {
      debug('reset:', this.current_action);
      this.resetting = true;
      if (this.current_action) {
        const { block, arg, finish } = this.current_action;
        debug('call finish: resetting');
        return error(ACTION_TERMINATED, {
          msg: 'action terminated due to resetting'
        }, finish);
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
          this.current_action = null;
          setImmediate(() => { return exec(); });
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
        const { block, arg, finish } = this.current_action;
        if (this.resetting) {
          debug('call finish: resetting');
          return error(ACTION_TERMINATED, {
            msg: 'action terminated'
          }, finish);
        }

        if (this[block.name]) {
          if (this.pending_error) {
            const err = this.pending_error;
            this.pending_error = null;
            return finish(err);
          }
          const scheduleTimeout = () => {
            return setTimeout(() => {
              return error(ACTION_TIMEOUT, {
                msg: 'action timeout',
                block: block
              }, finish);
            }, action_timeout);
          };
          let timeoutId = scheduleTimeout();
          const stopTimeout = () => {
            clearTimeout(timeoutId);
            timeoutId = null;
          };
          const extendTimeout = () => {
            debug('extendTimeout:', timeoutId);
            if (timeoutId) {
              stopTimeout();
              timeoutId = scheduleTimeout();
              debug('extendTimeout: new timeoutId', timeoutId);
            }
          };
          arg.extendTimeout = extendTimeout;
          try {
            return this[block.name](block, arg, (err) => {
              //debug('call finish: block callback', err, block);
              stopTimeout();
              return finish(err);
            });
          } catch (e) {
            debug('call finish: exception', e);
            stopTimeout();
            return error(ACTION_EXCEPTION, {
              msg: 'got unexpected exception',
              exception: e
            }, finish);
          }
        }
        debug('call finish: no such block', block);
        return error(ACTION_UNKNOWN_BLOCK, {
          msg: `no such block ${block.name}`
        }, finish);
      };
      push_action(block, arg || {}, cb);
      return exec();
    },
    // callbacks by pin number.
    callback: {
      'analog-read': {},
      'digital-read': {},
      'accelerometer-read': null,
      'bts01-reset': null,
      'bts01-cmd': null,
      'flash-erase': null,
      'flash-write': null,
      'flash-finish': null,
      'btpin': null
    },
    'port-init': function(block, arg, cb) {
      if (!initializer[block.type])
        return error(ACTION_UNKNOWN_BLOCK, null, cb);

      (initializer[block.type])(block.port);
      return error(ACTION_NO_ERROR, null, cb);
    },
    'port-settings': function(block, arg, cb) {
      const port_settings = block['port-settings'];
      /*
       * If true, reset only ports listed in port-settings.
       * Otherwise, reset other ports as default output or input
       * ports.
       */
      const reset_only = !!block['reset-only'];
      const calib = port => {
        if (typeof block['calibration'] !== 'object' ||
            typeof block['calibration'][port] !== 'object' ||
            typeof port_settings[port] !== 'string')
          return null;
        return block['calibration'][port][port_settings[port]];
      };
      debug(`port-settings: reset_only: ${reset_only}`, port_settings);
      SERVOMOTOR_STATE.synchronized = false;
      this.stop_melody = true;
      board.reset();
      /*
       * Multi LED configuration must be done first since it may
       * conflict with servomotor.
       */
      if (true) {
        debug(`setting multi-led`);
        init_multiled('RGB');
      }
      ['V0', 'V1'].forEach(port => {
        if (port_settings[port])
          init_dcmotor(port, calib(port));
      });
      const init_vport = port => {
        if (port_settings[port]) {
          debug(`setting port ${port}`);
          (initializer[port_settings[port]])(port, calib(port));
        } else {
          if (!reset_only) {
            (initializer['output'])(port);
          }
        }
      };
      const vports = ['V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'];
      const port_is = part => port => port_settings[port] === part;
      const complement = f => (...x) => !f(...x);
      /*
       * Initialize buzzer ports first, then initialize the rest.
       * The board.pinMode(pin, board.MODES.PWM) call in init_buzzer
       * changes the frequency of GCLK3 to 48MHz while buzzer and
       * servo motor requires it to be 8MHz.  init_servo() will set it
       * to back to 8MHz and each buzzer operation also sets it to
       * 8MHz.
       */
      vports.filter(port_is('buzzer')).forEach(init_vport);
      vports.filter(complement(port_is('buzzer'))).forEach(init_vport);
      ['K2', 'K3', 'K4', 'K5', 'K6', 'K7'].forEach(port => {
        if (reset_only)
          return;
        if (port_settings[port]) {
          debug(`setting port ${port}`);
          (initializer[port_settings[port]])(port);
        } else {
          (initializer['input'])(port);
        }
      });
      debug(`port-settings: all settings issued`);
      board.reportVersion(() => {
        debug('port-settings: report version done');
        return error(ACTION_NO_ERROR, null, cb);
      });
      debug(`port-settings: dummy query firmware issued`);
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
      [
        'accelerometer-read', 'bts01-reset', 'bts01-cmd',
        'flash-erase', 'flash-write', 'flash-finish', 'btpin'
      ].forEach(type => {
        board.addListener(type, v => {
          const callback = this.callback[type];
          debug(type, v);
          if (callback) {
            callback(v);
          }
        });
      });
      return error(ACTION_NO_ERROR, null, cb);
    },
    'turn-led': noreply(block => {
      var pin = KOOV_PORTS[block.port];
      if (typeof pin === 'number') {
        var on = block.mode === 'ON';
        board.digitalWrite(pin, on ? board.HIGH : board.LOW);
      }
    }),
    'multi-led': noreply((block, arg) => {
      let r = arg.r, g = arg.g, b = arg.b;
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
            power = to_integer(power);
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
    /* multi-led action for koov-1.0.7 or later */
    'multi-led.1': noreply((block, arg) => {
      const r = arg.r, g = arg.g, b = arg.b;
      debug(`multi-led.1: ${r}, ${g}, ${b}`, block);
      if (typeof r === 'number' &&
          typeof g === 'number' &&
          typeof b === 'number') {
        const rgb = [r, g, b].map(x => to_integer(clamp(0, 100, x)));
        const sysex = Buffer.concat([
          new Buffer([START_SYSEX, 0x0e, 0x02, 0x07 ]),
          new Buffer(rgb),
          new Buffer([END_SYSEX])]);
        debug(`multi-led.1:`, rgb, sysex);
        board.transport.write(sysex);
      }
    }),
    'buzzer-on': noreply((block, arg) => {
      const pin = KOOV_PORTS[block.port];
      if (typeof pin === 'number') {
        buzzer_on(board, pin, arg.frequency);
      }
    }),
    'buzzer-off': noreply(block => {
      const pin = KOOV_PORTS[block.port];
      if (typeof pin === 'number') {
        buzzer_off(board, pin);
      }
    }),
    'melody': function(block, arg, cb) {
      const pin = KOOV_PORTS[block.port];
      if (typeof pin !== 'number')
        return cb(null);
      debug(`melody: pin ${pin}`, arg.melody);
      this.stop_melody = false;
      const send = (melody) => {
        if (melody.length === 0)
          return;
        if (this.stop_melody) {
          debug(`melody: stop requested`);
          return;
        }
        const start = Date.now();
        const m = melody.slice(0, 20);
        const delay = m.reduce((acc, x) => acc + x.secs * 1000, 0);
        debug(`melody ${start}: sending (total ${delay}ms)`, m);
        play_melody(board, pin, m, true, (err) => {
          if (error_p(err)) {
            if (!this.pending_error)
              this.pending_error = err;
            return;
          }
          const now = Date.now();
          const wait = start + delay - now;
          debug(`melody ${now}: sent (wait ${wait}ms)`, m);
          return setTimeout(() => {
            return send(melody.slice(20));
          }, wait > 0 ? wait : 0);
        });
      };
      send(arg.melody);
      return cb(null);
    },
    /* melody action for koov-1.0.18 or later */
    'melody.1': function(block, arg, cb) {
      const pin = KOOV_PORTS[block.port];
      if (typeof pin !== 'number')
        return cb(null);
      debug(`melody: pin ${pin}`, arg.melody);
      this.stop_melody = false;
      const send = (melody) => {
        if (melody.length === 0)
          return;
        if (this.stop_melody) {
          debug(`melody: stop requested`);
          return;
        }
        const start = Date.now();
        const maxseq = 13;
        const m = melody.slice(0, maxseq);
        const delay = m.reduce((acc, x) => acc + x.secs * 1000, 0);
        debug(`melody ${start}: sending (total ${delay}ms)`, m);
        play_melody(board, pin, m, false, (err) => {
          if (error_p(err)) {
            if (!this.pending_error)
              this.pending_error = err;
            return;
          }
          const now = Date.now();
          const wait = start + delay - now;
          debug(`melody ${now}: sent (wait ${wait}ms)`, m);
          return setTimeout(() => {
            return send(melody.slice(maxseq));
          }, wait > 0 ? wait : 0);
        });
      };
      send(arg.melody);
      return cb(null);
    },
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
          debug(`move_nodelay: port ${port} degree ${degree}`);
          servoWrite(board, pin, degree);
        });
        setTimeout(() => {
          return error(ACTION_NO_ERROR, null, cb);
        }, max_delta * 3);
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
            const degree = curdeg + delta * count;
            debug(`move_withdelay: port ${port} degree ${degree}`);
            servoWrite(board, pin, degree);
          });
          if (count < max_delta)
            setTimeout(() => { return loop(); }, delay);
          else
            setTimeout(() => {
              return error(ACTION_NO_ERROR, null, cb);
            }, delay);
        };
        return loop();
      };
      if (arg.speed) {
        var v = arg;
        debug('servomotor-synchronized-motion[after]: ', v,
              SERVOMOTOR_STATE.expected_degree);
        SERVOMOTOR_STATE.synchronized = false;
        const speed = clamp(0, 100, v.speed) / 5; // 0..100 -> 0..20
        const delay = 20 - clamp(0, 20, speed);
        const delta = max_delta();
        if (delta === 0)
          return error(ACTION_NO_ERROR, null, cb);
        if (delay === 0)
          return move_nodelay(delta, cb);
        return move_withdelay(delta, cb, delay);
      } else {
        debug('servomotor-synchronized-motion[before]: ', arg);
        SERVOMOTOR_STATE.synchronized = true;
        SERVOMOTOR_STATE.expected_degree = {};
        SERVOMOTOR_STATE.current_degree = {};
        SERVOMOTOR_STATE.delta = {};
        return error(ACTION_NO_ERROR, null, cb);
      }
    },
    'set-servomotor-degree': noreply((block, arg) => {
      const port = block.port;
      const degree = clamp(0, 180, arg.degree);
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
    'set-servomotor-degrees': (block, arg, cb) => {
      debug(`set-servomotor-degrees: degrees:`, arg.degrees);
      Object.keys(arg.degrees).forEach(port => {
        const degree = clamp(0, 180, arg.degrees[port]);
        const pin = KOOV_PORTS[port];
        if (typeof pin === 'number') {
          servoWrite(board, pin, degree);
        }
      });
      if (arg.sync) {
        board.reportVersion(() => {
          debug('set-servomotor-degrees: report version done');
          return error(ACTION_NO_ERROR, null, cb);
        });
      } else {
        debug('set-servomotor-degrees: no sync');
        return error(ACTION_NO_ERROR, null, cb);
      }
    },
    'move-servomotors': (block, arg, cb) => {
      debug(`move-servomotors: degrees:`, arg.degrees);
      servomotor_synchronized_motion(board, arg.speed, arg.degrees);
      board.reportVersion(() => {
        debug('move-servomotors: report version done');
        SERVOMOTOR_STATE.synchronized = false;
        return error(ACTION_NO_ERROR, null, cb);
      });
    },
    'set-dcmotor-power': noreply((block, arg) => {
      dcmotor_power(board, block.port, arg.power);
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
    }, analog_scaler),
    'light-sensor-value': analog_reporter(pin => {
      board.pinMode(pin, board.MODES.INPUT);
    }, analog_scaler),
    'sound-sensor-value': analog_reporter(pin => {
      board.pinMode(pin, board.MODES.INPUT);
    }, sound_scaler),
    '3-axis-digital-accelerometer-value': function(block, arg, cb) {
      const port = block.port;
      if (port === 'K0' || port === 'K1') {
        const type = 'accelerometer-read';
        this.callback[type] = v => {
          this.callback[type] = null;
          const value = v.value;
          debug(`${type}: port: ${port} value: ${value} (${v.value})`);
          return error(ACTION_NO_ERROR, { error: false, value: value }, cb);
        };
        const direction =
              block.direction === 'x' ? 0x01 :
              block.direction === 'y' ? 0x02 : 0x03;
        board.transport.write(new Buffer([
          START_SYSEX, 0x0e, 0x01, direction, END_SYSEX
        ]));
      } else
        return error(ACTION_UNKNOWN_PORT, {
          error: true,
          msg: `${type}: unknown port ${port}`,
          value: 0
        }, cb);
    },
    'bts01-reset': function(block, arg, cb) {
      if (!arg)
        arg = {};
      const timeout = arg.timeout || 1000;
      const type = 'bts01-reset';
      debug('bts01-reset:', arg);
      this.callback[type] = v => {
        this.callback[type] = null;
        debug(`${type}:`, v);
        v.error = false;
        return error(ACTION_NO_ERROR, v, cb);
      };
      board.transport.write(Buffer.concat([
        new Buffer([START_SYSEX, 0x0e, 0x02, 0x01]),
        new Buffer([(timeout >> 7) & 0x7f, timeout & 0x7f]),
        new Buffer(arg.command ? arg.command : []),
        new Buffer([END_SYSEX])
      ]), (err) => {
/*
        debug('board.transport.write callback: bts01-reset:', err);
        return error(ACTION_NO_ERROR, null, cb);
*/
        if (err) {
          this.callback[type] = null;
          return error(ACTION_BTS01CMD_FAILURE, {
            error: true,
            msg: 'failed to control ble module',
            original_error: err
          }, cb);
        }
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
        v.error = false;
        return error(ACTION_NO_ERROR, v, cb);
      };
      board.transport.write(cmd, (err) => {
        debug('board.transport.write callback: bts01-cmd:', err);
        if (err) {
          this.callback[type] = null;
          return error(ACTION_BTS01CMD_FAILURE, {
            error: true,
            msg: 'failed to control ble module',
            original_error: err
          }, cb);
        }
      });
    },
    'flash-write': function(block, arg, cb) {
      const { data, progress } = arg;
      let total = 0;
      const flash_cmd = (opts) => {
        const { type, command, error_code, cont } = opts;
        debug(`${type}`, command);
        const cleanup = (err) => {
          this.callback[type] = null;
          return error(error_code, {
            error: true,
            msg: 'failed to write flash',
            original_error: err
          }, cb);
        };
        this.callback[type] = v => {
          this.callback[type] = null;
          debug(`${type}: done`, v);
          v.error = false;
          return cont(v);
        };
        board.transport.write(Buffer.from(command), (err) => {
          if (err)
            return cleanup(err);
        });
      };
      const flash_erase = (cont) => {
        return flash_cmd({
          type: 'flash-erase',
          command: [ START_SYSEX, 0x0e, 0x02, 0x08, END_SYSEX ],
          error_code: ACTION_FLASH_ERASE_FAILURE,
          cont: cont
        });
      };
      const flash_write = (buffer, cont) => {
        return flash_cmd({
          type: 'flash-write',
          command: buffer,
          error_code: ACTION_FLASH_WRITE_FAILURE,
          cont: cont
        });
      };
      const flash_finish = () => {
        return flash_cmd({
          type: 'flash-finish',
          command: [ START_SYSEX, 0x0e, 0x02, 0x09, END_SYSEX ],
          error_code: ACTION_FLASH_FINISH_FAILURE,
          cont: (v) => error(ACTION_NO_ERROR, v, cb)
        });
      };
      const write = (data) => {
	progress({ written: (total - data.length), total: total });
        if (data.length === 0)
          return flash_finish();

        arg.extendTimeout();
        const maxlen = 50;
        const length = data.length > maxlen ? maxlen : data.length;
        const b = Buffer.from([
          START_SYSEX, 0x0e, 0x02, 0x0a, length
        ].concat(data.slice(0, length), END_SYSEX));
        return flash_write(b, (v) => write(data.slice(length)));
      };
      const escape = (b) => {
        debug('escape:', b);
        const ESCAPE_CHAR = 0x7f;
        // Convert from buffer to array since Buffer on iOS 9.3.5
        // webkit doesn't implement reduce method.
        return Array.prototype.slice.call(b, 0).reduce((acc, x) => {
	  if (x === ESCAPE_CHAR) {
	    acc.push(ESCAPE_CHAR);
	    acc.push(0);
          } else if (x === END_SYSEX) {
	    acc.push(ESCAPE_CHAR);
	    acc.push(1);
	  } else
	    acc.push(x);
	  return acc;
        }, []);
      };
      return flash_erase((v) => {
        const b = escape(data);
        total = b.length;
        return write(b)
      });
    },
    'btpin': function(block, arg, cb) {
      debug('btpin', arg);
      const timeout = arg.timeout || 1000;
      const cmd = Buffer.concat([
        new Buffer([ START_SYSEX, 0x0e, 0x02, 0x0b ]),
        new Buffer(arg.command),
        new Buffer([END_SYSEX])
      ]);
      const type = 'btpin';
      this.callback[type] = v => {
        this.callback[type] = null;
        debug(`${type}: callback`, v);
        if (v.buffer[1] !== 0) {
          v.error = true;
          return error(ACTION_BTPIN_FAILURE, v, cb);
        }
        v.error = false;
        return error(ACTION_NO_ERROR, v, cb);
      };
      board.transport.write(cmd, (err) => {
        debug('board.transport.write callback: btpin:', err);
        if (err) {
          this.callback[type] = null;
          return error(ACTION_BTS01CMD_FAILURE, {
            error: true,
            msg: 'failed to control ble module',
            original_error: err
          }, cb);
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
        return error(ACTION_NO_ERROR, null, cb);
      });
    },
    'firmata-version': function(block, arg, cb) {
      debug('firmata-version', arg);
      return error(ACTION_NO_ERROR, {
        error: false, version: board.firmware.version
      }, cb);
    },
    'firmata-name': function(block, arg, cb) {
      debug('firmata-name', arg);
      const name = board.firmware.name;
      let { major, minor, patch } = { major: 0, minor: 0, patch: 0 };
      if (name && typeof name === 'string') {
        const m = name.match(/koov-(\d+)\.(\d+)\.(\d+)/);
        if (m) {
          [ major, minor, patch ] = m.slice(1, 4);
        }
      }
      return error(ACTION_NO_ERROR, {
        error: false, name: name, major: major, minor: minor, patch: patch
      }, cb);
    },
    'servomotor-degrees': function(block, arg, cb) {
      debug('servomotor-degrees: arg', arg, SERVOMOTOR_DEGREE);
      const degrees = Object.keys(KOOV_PORTS).reduce((acc, port) => {
        const pin = KOOV_PORTS[port];
        //debug(`servomotor-degrees: port ${port}, pin ${pin}`);
        if (typeof pin === 'number') {
          const degree = SERVOMOTOR_DEGREE[pin];
          if (typeof degree === 'number')
            acc[port] = degree;
        }
        return acc;
      }, {});
      debug('servomotor-degrees: degrees', degrees);
      return error(ACTION_NO_ERROR, {
        error: false,
        degrees: degrees,
        state: SERVOMOTOR_STATE,
        selected_device: selected_device
      }, cb);
    },
    'reset-servomotor-synchronized-motion': function(block, arg, cb) {
      debug('reset-servomotor-synchronized-motion: arg', arg);
      SERVOMOTOR_STATE.synchronized = false;
      board.reportVersion(() => {
        debug('reset-servomotor-synchronized-motion: report version done');
        return error(ACTION_NO_ERROR, null, cb);
      });
    },
    'sync-device': function(block, arg, cb) {
      debug('sync-device: arg', arg);
      board.reportVersion(() => {
        debug('sync-device: report version done');
        return error(ACTION_NO_ERROR, null, cb);
      });
    }
  };
};

const open_firmata = (action, cb, opts) => {
  debug('firmata open', opts);
  const action_timeout = opts.action_timeout || 60 * 1000;
  dcmotor_correction = opts.dcmotor_correction;
  let called = false;
  const callback = (err) => {
    if (called)
      return;
    called = true;
    clearTimeout(timeoutId);
    return cb(err);
  };
  const version_mismatch = (version) => {
    const exists = version => version && version.major;
    return exists(version) && version.major != ACTION_REQUIRED_FIRMATA_VERSION;
  };
  const timeoutId = setTimeout(() => {
    const version = board.version;
    const error_code = version_mismatch(version) ?
          ACTION_FIRMATA_VERSION_MISMATCH :
          ACTION_OPEN_FIRMATA_TIMEDOUT;
    return error(error_code, {
      msg: 'failed to open firmata',
      version: version
    }, callback);
  }, opts.open_firmata_timeout);
  const firmata = require('firmata');
  const transport = {
    write: (data, cb) => {
      //debug('transport: write', data);
      return action.device.serial_write(data, (err) => {
        //debug('transport: write', err);
        if (cb)
          return error(err ? ACTION_WRITE_ERROR : ACTION_NO_ERROR, err, cb);
      });
    },
    on: (what, cb) => {
      //debug('transport: on', what);
      return action.device.serial_event(what, (err) => {
        //debug('transport: on', err);
      }, cb);
    }
  };
  const board = new firmata.Board(transport, {
    reportVersionTimeout: 0,
    //reportVersionTimeout: 5000,
    //samplingInterval: 10000
    skipCapabilities: true,
    btpin: opts.btpin || ACTION_BTPIN_NULL,
    analogPins: [ 0, 1, 2, 3, 4, 5 ], // we have six analog pins
    pins: [
      {
        supportedModes: [ 0, 1, 2, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 24
      },
      {
        supportedModes: [ 0, 1, 2, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 25
      },
      {
        supportedModes: [ 0, 1, 2, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 26
      },
      {
        supportedModes: [ 0, 1, 2, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 27
      },
      {
        supportedModes: [ 0, 1, 2, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 28
      },
      {
        supportedModes: [ 0, 1, 2, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 29
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 6, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 6, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 3, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      },
      {
        supportedModes: [ 0, 1, 4, 11 ],
        value: 0,
        report: 1,
        analogChannel: 127
      }
    ]
  }, (err) => {
    debug('firmata open', err);
    if (err)
      return error(ACTION_OPEN_FIRMATA_FAILURE, err, callback);
    if (!board.firmware.name)
      return error(ACTION_BTPIN_FAILURE, { msg: 'btpin failure' }, callback);
    const version = board.version;
    if (version_mismatch(version))
      return error(ACTION_FIRMATA_VERSION_MISMATCH, {
        msg: 'failed to open firmata',
        version: version
      }, callback);
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
      }, opts.keep_alive_interval);
      debug('keep_alive: set timeout');
    };
    action.action['board-init'](null, null, (err) => {
      if (!error_p(err))
        keep_alive();
      callback(err);
    });
  });
  action.board = board;
  action.action = koov_actions(board, action_timeout, action.selected_device);
};

function Action(opts)
{
  this.board = null;
  this.action = null;
  this.keepAliveId = null;
  this.device = opts.device;
  this.selected_device = null;

  this.BTPIN_PROBE = ACTION_BTPIN_PROBE;
  this.BTPIN_NULL = ACTION_BTPIN_NULL;

  if (opts.debug)
    debug = opts.debug;
  const terminate_device = () => {
    this.terminate_device(() => {
      this.close((err) => {
        debug('action: disconnected: close completed', err);
      });
    });
  };
  const on_disconnect = () => {
    debug('action: disconnected', this.device);
    terminate_device();
  };
  this.on_disconnect = on_disconnect;
  const on_error = (err) => {
    debug('action: error', err);
    if (err)
      terminate_device();
  };
  this.on_error = on_error;
  const on_close = (err) => {
    debug('action: close', err);
    if (err)
      terminate_device();
  };
  this.on_close = on_close;
  this.terminate_device = (cb) => {
    if (!this.device)
      return cb();
    debug('terminating device');
    this.device.terminate(cb);
  };
  this.open = function(name, open_opts) {
    debug('action: open', name);

    if (typeof open_opts === 'function') {
      open_opts = { callback: open_opts };
    }
    const cb = open_opts.callback;

    if (!this.device)
      return error(ACTION_NO_DEVICE, { msg: 'no device found' }, cb);
    this.selected_device = name;
    this.device.open(name, (err) => {
      debug('action: serial: open', err);
      if (error_p(err))
        return cb(err);
      return open_firmata(this, (err) => {
        if (error_p(err))
          return cb(err);
        this.board.on('disconnect', on_disconnect);
        this.board.on('error', on_error);
        this.board.on('close', on_close);
        return error(ACTION_NO_ERROR, null, cb);
      }, {
        open_firmata_timeout: opts.open_firmata_timeout || 10000,
        keep_alive_interval: opts.keep_alive_interval || 5 * 1000,
        action_timeout: opts.action_timeout || 60 * 1000,
        dcmotor_correction: opts.dcmotor_correction,
        btpin: open_opts.btpin
      });
    });
  };
  this.clear_keep_alive = function() {
    debug('clear_keep_alive:', this.keepAliveId);
    if (this.keepAliveId) {
      debug('close: clear keep alive timer');
      clearTimeout(this.keepAliveId);
      this.keepAliveId = null;
    }
  };
  this.close = function(cb) {
    debug('action: close');
    this.selected_device = null;
    this.clear_keep_alive();
    if (this.action)
      this.action.reset();
    return this.device.close(cb);
  };
};

module.exports = {
  action: (opts) => { return new Action(opts); }
};
