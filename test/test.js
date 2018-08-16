/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 */

const assert = require('assert');
const rewire = require('rewire');
const sinon = require('sinon');

describe('terminate_device without device', () => {
  it('should call callback', (done) => {
    const ka = require('../koovdev_action').action({
    });
    ka.terminate_device(done);
  });
});

describe('terminate_device with device', () => {
  it('should call callback', (done) => {
    const terminate = sinon.spy();
    const ka = require('../koovdev_action').action({ device: { terminate } });
    const callback = () => {};
    const callback2 = () => { callback(); };

    ka.terminate_device(callback);
    assert(terminate.calledOnceWith(callback));
    ka.terminate_device(callback2);
    assert(terminate.getCall(1).callback === callback2);

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
