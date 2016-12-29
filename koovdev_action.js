/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
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
    { power: 20, rpm: 0 },
    { power: 30, rpm: 22.5 },
    { power: 40, rpm: 35.4 },
    { power: 50, rpm: 45.7 },
    { power: 60, rpm: 58.2 },
    { power: 70, rpm: 65.8 },
    { power: 80, rpm: 68.2 },
    { power: 90, rpm: 69.7 },
    { power: 100, rpm: 71.2 },
  ],
  REVERSE: [
    { power: 0, rpm: 0 },
    { power: 10, rpm: 0 },
    { power: 20, rpm: 3.8 },
    { power: 30, rpm: 8.3 },
    { power: 40, rpm: 15.2 },
    { power: 50, rpm: 19.2 },
    { power: 60, rpm: 29.9 },
    { power: 70, rpm: 48.6 },
    { power: 80, rpm: 58.5 },
    { power: 90, rpm: 65.5 },
    { power: 100, rpm: 71.3 },
  ]
};
const DCMOTOR_RPM_MAX = 70;
const DCMOTOR_RPM_MIN = 25;
const DCMOTOR_POWER_SWITCH = 10;

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
  { port: 'V0', power: 0, mode: 'COAST' },
  { port: 'V1', power: 0, mode: 'COAST' }
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
    DCMOTOR_MODE[dm.mode](board, pins, dm.power);
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

const servoWrite = (board, pin, degree) => {
  SERVOMOTOR_DEGREE[pin] = degree;
  board.servoWrite(pin, to_integer(degree));
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

/*
 * Generate action dispatch table for KOOV.
 */
function koov_actions(board, action_timeout) {
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
      return error(ACTION_NO_ERROR, null, cb);
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
          const timeoutId = setTimeout(() => {
            return error(ACTION_TIMEOUT, {
              msg: 'action timeout',
              block: block
            }, finish);
          }, action_timeout);
          try {
            return this[block.name](block, arg, (err) => {
              //debug('call finish: block callback', err, block);
              clearTimeout(timeoutId);
              return finish(err);
            });
          } catch (e) {
            debug('call finish: exception', e);
            clearTimeout(timeoutId);
            return error(ACTION_EXCEPTION, {
              msg: 'got unexpected exception',
              exception: e
            }, finish);
          }
        }
        debug('call finish: no such block');
        return error(ACTION_UNKNOWN_BLOCK, {
          msg: `no such block ${block.name}`
        }, finish);
      };
      push_action(block, arg, cb);
      return exec();
    },
    // callbacks by pin number.
    callback: {
      'analog-read': {},
      'digital-read': {},
      'accelerometer-read': null,
      'bts01-reset': null,
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
      debug(`port-settings: all settings issued`);
      board.queryFirmware(() => {
        debug('port-settings: query firmware done');
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
      ['accelerometer-read', 'bts01-reset', 'bts01-cmd'].forEach(type => {
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
        turn_fet(board, pin, on);
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
            servoWrite(board, pin, curdeg + delta * count);
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
      if (arg) {
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
      return error(ACTION_NO_ERROR, {
        error: false, name: board.firmware.name
      }, cb);
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
  const timeoutId = setTimeout(() => {
    return error(ACTION_OPEN_FIRMATA_TIMEDOUT, {
      msg: 'failed to open firmata'
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
  }, (err) => {
    debug('firmata open', err);
    if (err)
      return error(ACTION_OPEN_FIRMATA_FAILURE, err, callback);
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
    };
    action.action['board-init'](null, null, callback);
    keep_alive();
  });
  action.board = board;
  action.action = koov_actions(board, action_timeout);
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
      return error(ACTION_NO_DEVICE, { msg: 'no device found' }, cb);
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
        dcmotor_correction: opts.dcmotor_correction
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
