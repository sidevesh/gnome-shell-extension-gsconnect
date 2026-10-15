// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';


const MockSessionComponent = GObject.registerClass({
    GTypeName: 'GSConnectMockSession',
    Signals: {
        'changed': {
            flags: GObject.SignalFlags.RUN_FIRST,
        },
    },
}, class MockSessionComponent extends GObject.Object {

    get idle() {
        if (this._idle === undefined)
            this._idle = false;

        return this._idle;
    }

    get locked() {
        if (this._locked === undefined)
            this._locked = false;

        return this._locked;
    }

    get active() {
        // Active if not idle and not locked
        return !(this.idle || this.locked);
    }

    lock() {
        this.update({locked: true});

        return Promise.resolve();
    }

    unlock() {
        this.update({locked: false});

        return Promise.resolve();
    }

    /**
     * Update the session with an object of properties and values.
     *
     * @param {object} obj - A dictionary of properties
     */
    update(obj) {
        for (const [propertyName, propertyValue] of Object.entries(obj))
            this[`_${propertyName}`] = propertyValue;

        this.emit('changed');
    }
});

export default MockSessionComponent;
