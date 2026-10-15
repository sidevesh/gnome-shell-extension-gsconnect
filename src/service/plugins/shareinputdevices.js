// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Plugin from '../plugin.js';


export const Metadata = {
    label: _('Share Input Devices'),
    description: _('Move the pointer off an edge of the screen to use this computer’s mouse and keyboard on the device'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.ShareInputDevices',
    enabledByDefault: false,
    incomingCapabilities: [
        'kdeconnect.shareinputdevices',
    ],
    outgoingCapabilities: [
        'kdeconnect.mousepad.request',
        'kdeconnect.shareinputdevices.request',
    ],
    actions: {
        shareInputEnter: {
            label: _('Share Input Devices'),
            icon_name: 'input-mouse-symbolic',

            parameter_type: new GLib.VariantType('(dd)'),
            incoming: ['kdeconnect.shareinputdevices'],
            outgoing: ['kdeconnect.shareinputdevices.request'],
        },
        shareInputEvents: {
            label: _('Share Input Devices'),
            icon_name: 'input-mouse-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: ['kdeconnect.shareinputdevices'],
            outgoing: ['kdeconnect.mousepad.request'],
        },
    },
};


/**
 * The screen edges, as the Qt::Edge values KDE Connect uses.
 */
export const Edge = {
    top: 0x1,
    left: 0x2,
    right: 0x4,
    bottom: 0x8,
};

/**
 * The fields of a `kdeconnect.mousepad.request` that may be forwarded.
 */
const MOUSEPAD_FIELDS = [
    'dx', 'dy', 'scroll',
    'singleclick', 'singlehold', 'singlerelease', 'middleclick', 'rightclick',
    'key', 'specialKey', 'shift', 'ctrl', 'alt', 'super', 'sendAck',
];


/**
 * ShareInputDevices Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/shareinputdevices
 *
 * When the pointer is pushed off the configured edge of the screen, GNOME
 * Shell captures the mouse and keyboard and forwards their input here, which
 * passes it to the device. KDE Connect for Android shows its cursor at the
 * matching edge, and hands the pointer back when it is moved off that edge.
 *
 * The shell reads the edge from the `shareInputEdge` action state, and learns
 * where the pointer was handed back from the `shareInputRelease` action state.
 */
const ShareInputDevicesPlugin = GObject.registerClass({
    GTypeName: 'GSConnectShareInputDevicesPlugin',
}, class ShareInputDevicesPlugin extends Plugin {

    _init(device) {
        super._init(device, 'shareinputdevices');

        this._releaseSerial = 0;

        this._edgeAction = new Gio.SimpleAction({
            name: 'shareInputEdge',
            parameter_type: null,
            state: new GLib.Variant('s', this._getEdge()),
            enabled: false,
        });
        this.device.add_action(this._edgeAction);

        this._releaseAction = new Gio.SimpleAction({
            name: 'shareInputRelease',
            parameter_type: null,
            state: new GLib.Variant('(udd)', [0, 0, 0]),
            enabled: false,
        });
        this.device.add_action(this._releaseAction);

        this._edgeChangedId = this.settings.connect('changed::edge', () => {
            this._edgeAction.set_state(new GLib.Variant('s', this._getEdge()));
        });
    }

    _getEdge() {
        const edge = this.settings.get_string('edge');

        return Edge.hasOwnProperty(edge) ? edge : 'left';
    }

    connected() {
        super.connected();

        const enabled = this.device.lookup_action('shareInputEnter').enabled;
        this._edgeAction.set_enabled(enabled);
        this._releaseAction.set_enabled(enabled);
    }

    disconnected() {
        super.disconnected();

        this._edgeAction.set_enabled(false);
        this._releaseAction.set_enabled(false);
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.shareinputdevices':
                if (packet.body.hasOwnProperty('releaseDeltax'))
                    this._handleRelease(packet.body);
                break;
        }
    }

    /**
     * Tell the shell the device handed the pointer back, and where along the
     * edge, relative to its start.
     *
     * @param {object} body - The body of a `kdeconnect.shareinputdevices`
     */
    _handleRelease(body) {
        const dx = Number(body.releaseDeltax) || 0;
        const dy = Number(body.releaseDeltay) || 0;

        this._releaseSerial = (this._releaseSerial + 1) % 0xffffffff;
        this._releaseAction.set_state(new GLib.Variant('(udd)',
            [this._releaseSerial, dx, dy]));
    }

    /**
     * Hand the pointer to the device, where it left the screen.
     *
     * @param {number} dx - Its horizontal distance from the start of the edge
     * @param {number} dy - Its vertical distance from the start of the edge
     */
    shareInputEnter(dx, dy) {
        this.device.sendPacket({
            type: 'kdeconnect.shareinputdevices.request',
            body: {
                exitEdge: Edge[this._getEdge()],
                deltax: Math.round(dx),
                deltay: Math.round(dy),
            },
        });
    }

    /**
     * Forward a batch of input events from the shell to the device.
     *
     * @param {string} json - A JSON array of `kdeconnect.mousepad.request`
     *   packet bodies
     */
    shareInputEvents(json) {
        let events;

        try {
            events = JSON.parse(json);
        } catch (e) {
            debug(e, this.device.name);
            return;
        }

        if (!Array.isArray(events))
            return;

        for (const event of events) {
            const body = {};

            for (const field of MOUSEPAD_FIELDS) {
                if (event?.hasOwnProperty(field))
                    body[field] = event[field];
            }

            if (Object.keys(body).length > 0) {
                this.device.sendPacket({
                    type: 'kdeconnect.mousepad.request',
                    body: body,
                });
            }
        }
    }

    destroy() {
        this.settings.disconnect(this._edgeChangedId);
        this.device.remove_action('shareInputEdge');
        this.device.remove_action('shareInputRelease');

        super.destroy();
    }
});

export default ShareInputDevicesPlugin;
