/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 */

const assert = require('assert');
const rewire = require('rewire');
const sinon = require('sinon');
const { promisify } = require('util');

describe('terminate_device without device', () => {
  it('should call callback', (done) => {
    const ka = require('../koovdev_action').action({
    });
    ka.terminate_device(done);
  });
});

describe('terminate_device with device', () => {
  it('should call callback', (done) => {
    const ka = require('../koovdev_action').action({
      device: { terminate: (cb) => cb(null)}});
    const callback = sinon.spy();
    const callback2 = () => { callback(); };

    assert(callback.callCount === 0);
    ka.terminate_device(callback);
    assert(callback.callCount === 1);
    ka.terminate_device(callback2);
    assert(callback.callCount === 2);

    ka.action = { current_action: () => {} };
    ka.terminate_device(callback);
    assert(callback.callCount === 3);
    assert(ka.action.current_action === null);

    done();
  });
});

describe('on_disconnect etc', () => {
  it('should call this.terminate_device', (done) => {
    const terminate = sinon.spy();
    const ka = require('../koovdev_action').action({ device: { terminate } });

    ka.on_disconnect();
    assert(terminate.calledOnce);
    ka.on_error(true);
    assert(terminate.calledTwice);
    ka.on_close(true);
    assert(terminate.calledThrice);
    done();
  });
});

const setup_action = () => {
  const terminate = sinon.spy();
  const koovdev_action = rewire('../koovdev_action');
  const koov_actions = koovdev_action.__get__('koov_actions');
  const board = {
    digitalWrite: sinon.spy(),
    analogWrite: sinon.spy(),
    HIGH: 'HIGH',
    LOW: 'LOW',
    on: sinon.spy() };

  koovdev_action.__set__('open_firmata', (action, cb, opts) => {
    const action_timeout = opts.action_timeout || 60 * 1000;
    action.board = board;
    action.action = koov_actions(
      board, action_timeout, action.selected_device);
    cb(null);
  });

  const action = koovdev_action.action({
    device: {
      open: (name, cb) => cb(null),
      close: cb => cb(null),
      terminate }});
  const open = promisify((name, cb) => {
    const v = action.open(name, { callback: cb});
    return v;
  });
  const close = promisify(cb => action.close(cb));

  return {
    board,
    action,
    open,
    close };
};

describe('turn_led', () => {
  it('should work', async () => {
    const { action, board, open, close } = setup_action();

    assert.equal(await open('/dev/null'), null);
    assert(board.on.calledThrice);

    const fn = promisify(action.action['turn-led']);

    assert.equal(await fn({
      name: 'turn-led',
      port: 'V2',
      mode: 'ON'
    }, null), null);
    assert(board.digitalWrite.calledOnce);
    assert.deepEqual(board.digitalWrite.args[0], [10, 'HIGH']);

    assert.equal(await fn({
      name: 'turn-led',
      port: 'V3',
      mode: 'OFF'
    }, null), null);
    assert(board.digitalWrite.calledTwice);
    assert.deepEqual(board.digitalWrite.args[1], [11, 'LOW']);

    assert.equal(await close(), null);
  });
});

describe('dcmotor_control', () => {
  it('should work', async () => {
    const { action, board, open, close } = setup_action();

    assert.equal(await open('/dev/null'), null);
    assert(board.on.calledThrice);

    const set_dcmotor_power = promisify(action.action['set-dcmotor-power']);
    const turn_dcmotor_on = promisify(action.action['turn-dcmotor-on']);
    const turn_dcmotor_off = promisify(action.action['turn-dcmotor-off']);

    assert.equal(await set_dcmotor_power({
      name: 'set-dcmotor-power',
      port: 'V0',
      power: { name: 'plus', x: 40, y: 60 },
    }, {
      power: 100                // this is calculated value.
    }), null);
    assert(board.digitalWrite.calledOnce);
    assert.deepEqual(board.digitalWrite.args[0], [ 13, 'LOW' ]);
    assert(board.analogWrite.calledOnce);
    assert.deepEqual(board.analogWrite.args[0], [ 12, 0 ]);

    assert.equal(await turn_dcmotor_on({
      name: 'turn-dcmotor-on',
      port: 'V0',
      direction: 'NORMAL'
    }, null), null);
    assert.equal(board.digitalWrite.callCount, 2);
    assert.deepEqual(board.digitalWrite.args[1], [ 13, 'LOW' ]);
    assert.equal(board.analogWrite.callCount, 3);
    assert.deepEqual(board.analogWrite.args[1], [ 12, 255 ]);
    assert.deepEqual(board.analogWrite.args[2], [ 12, 254 ]);

    assert.equal(await set_dcmotor_power({
      name: 'set-dcmotor-power',
      port: 'V0',
      power: { name: 'plus', x: 40, y: 10 }
    }, {
      power: 50                 // this is calculated value.
    }), null);
    assert.equal(board.digitalWrite.callCount, 3);
    assert.deepEqual(board.digitalWrite.args[2], [ 13, 'LOW' ]);
    assert.equal(board.analogWrite.callCount, 4);
    assert.deepEqual(board.analogWrite.args[3], [ 12, 107 ]);

    assert.equal(await turn_dcmotor_off({
      name: 'turn-dcmotor-off',
      port: 'V0',
      mode: 'BRAKE'
    }, null), null);
    assert.equal(board.digitalWrite.callCount, 4);
    assert.deepEqual(board.digitalWrite.args[3], [ 13, 'HIGH' ]);
    assert.equal(board.analogWrite.callCount, 5);
    assert.deepEqual(board.analogWrite.args[4], [ 12, 255 ]);

    assert.equal(await turn_dcmotor_on({
      name: 'turn-dcmotor-on',
      port: 'V0',
      direction: 'REVERSE'
    }, null), null);
    assert.equal(board.digitalWrite.callCount, 5);
    assert.deepEqual(board.digitalWrite.args[4], [ 13, 'HIGH' ]);
    assert.equal(board.analogWrite.callCount, 7);
    assert.deepEqual(board.analogWrite.args[5], [ 12, 0 ]);
    assert.deepEqual(board.analogWrite.args[6], [ 12, 67 ]);

    assert.equal(await turn_dcmotor_off({
      name: 'turn-dcmotor-off',
      port: 'V0',
      mode: 'COAST'
    }, null), null);
    assert.equal(board.digitalWrite.callCount, 6);
    assert.deepEqual(board.digitalWrite.args[5], [ 13, 'LOW' ]);
    assert.equal(board.analogWrite.callCount, 8);
    assert.deepEqual(board.analogWrite.args[7], [ 12, 0 ]);

    assert.equal(await close(), null);
  });
});
