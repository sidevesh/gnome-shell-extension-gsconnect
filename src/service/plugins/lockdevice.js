// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Components from '../components/index.js';
import Plugin from '../plugin.js';


export const Metadata = {
    label: _('Lock'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.LockDevice',
    description: _('Lock and unlock this computer from the paired computer, and the paired computer from here'),
    incomingCapabilities: [
        'kdeconnect.lock',
        'kdeconnect.lock.request',
    ],
    outgoingCapabilities: [
        'kdeconnect.lock',
        'kdeconnect.lock.request',
    ],
    actions: {
        lock: {
            label: _('Lock'),
            icon_name: 'system-lock-screen-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.lock'],
            outgoing: ['kdeconnect.lock.request'],
        },
        unlock: {
            label: _('Unlock'),
            icon_name: 'changes-allow-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.lock'],
            outgoing: ['kdeconnect.lock.request'],
        },
    },
};


/**
 * LockDevice Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/lockdevice
 *
 * KDE Connect for Android doesn't implement this plugin; phones lock the
 * computer with the "Lock" command of the RunCommand plugin instead.
 */
const LockDevicePlugin = GObject.registerClass({
    GTypeName: 'GSConnectLockDevicePlugin',
}, class LockDevicePlugin extends Plugin {

    _init(device) {
        super._init(device, 'lockdevice');

        this._session = Components.acquire('session');
        this._locked = this._session.locked;
        this._sessionChangedId = this._session.connect('changed',
            this._onSessionChanged.bind(this));

        // Whether the remote device is locked, which decides whether the
        // device menu offers to lock or to unlock it
        this._remoteLocked = false;
    }

    connected() {
        super.connected();

        this._sendState();
        this.device.sendPacket({
            type: 'kdeconnect.lock.request',
            body: {requestLocked: true},
        });
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.lock':
                this._handleState(packet.body);
                break;

            case 'kdeconnect.lock.request':
                this._handleRequest(packet.body);
                break;
        }
    }

    /**
     * Handle the state of the remote device, or the result of a request to
     * lock it.
     *
     * @param {object} body - The body of a `kdeconnect.lock` packet
     */
    _handleState(body) {
        if (typeof body.isLocked === 'boolean' &&
            body.isLocked !== this._remoteLocked) {
            this._remoteLocked = body.isLocked;
            this._updateMenuItem();
        }

        if (body.lockResult === false) {
            this.device.showNotification({
                id: 'lock-failed',
                title: this.device.name,
                // TRANSLATORS: Locking a paired computer failed
                body: _('Failed to lock'),
                icon: new Gio.ThemedIcon({name: 'dialog-error-symbolic'}),
            });
        }
    }

    /**
     * Handle a request to lock or unlock this computer, or to send its state.
     * As in KDE Connect, a paired device can unlock this computer without the
     * password.
     *
     * @param {object} body - The body of a `kdeconnect.lock.request` packet
     */
    async _handleRequest(body) {
        if (body.hasOwnProperty('requestLocked'))
            this._sendState();

        if (body.setLocked === false) {
            try {
                await this._session.unlock();
            } catch (e) {
                debug(e, this.device.name);
            }

            return;
        }

        if (body.setLocked !== true)
            return;

        let success = true;

        try {
            await this._session.lock();
        } catch (e) {
            debug(e, this.device.name);
            success = false;
        }

        this.device.sendPacket({
            type: 'kdeconnect.lock',
            body: {lockResult: success},
        });
    }

    /**
     * Show "Unlock" in the device menu while the remote device is locked, and
     * "Lock" otherwise, as KDE Connect does.
     */
    _updateMenuItem() {
        let index = this.device.removeMenuAction('device.lock');

        if (index === -1)
            index = this.device.removeMenuAction('device.unlock');

        // Not shown in the menu
        if (index === -1)
            return;

        const name = this._remoteLocked ? 'unlock' : 'lock';
        const info = this._meta.actions[name];

        this.device.addMenuAction(this.device.lookup_action(name), index,
            info.label, info.icon_name);
    }

    _onSessionChanged() {
        if (this._locked === this._session.locked)
            return;

        this._locked = this._session.locked;
        this._sendState();
    }

    _sendState() {
        this.device.sendPacket({
            type: 'kdeconnect.lock',
            body: {isLocked: this._session.locked},
        });
    }

    /**
     * Lock the remote device.
     */
    lock() {
        this.device.sendPacket({
            type: 'kdeconnect.lock.request',
            body: {setLocked: true},
        });
    }

    /**
     * Unlock the remote device.
     */
    unlock() {
        this.device.sendPacket({
            type: 'kdeconnect.lock.request',
            body: {setLocked: false},
        });
    }

    destroy() {
        this._session.disconnect(this._sessionChangedId);
        this._session = Components.release('session');

        super.destroy();
    }
});

export default LockDevicePlugin;
