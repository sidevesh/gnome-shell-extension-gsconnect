// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';


/**
 * The DNS-SD service type used by KDE Connect.
 */
export const SERVICE_TYPE = '_kdeconnect._udp';

const AVAHI_NAME = 'org.freedesktop.Avahi';
const AVAHI_SERVER_IFACE = 'org.freedesktop.Avahi.Server2';
const AVAHI_ENTRY_GROUP_IFACE = 'org.freedesktop.Avahi.EntryGroup';
const AVAHI_SERVICE_BROWSER_IFACE = 'org.freedesktop.Avahi.ServiceBrowser';

const AVAHI_IF_UNSPEC = -1;
const AVAHI_PROTO_UNSPEC = -1;
const AVAHI_PROTO_INET = 0;
const AVAHI_ENTRY_GROUP_COLLISION = 3;
const AVAHI_ENTRY_GROUP_FAILURE = 4;


/**
 * Build the TXT records KDE Connect publishes with its service.
 *
 * @param {object} info - The service information
 * @returns {Uint8Array[]} The TXT records
 */
export function buildTxtRecords(info) {
    const encoder = new TextEncoder();

    return [
        `id=${info.id}`,
        `name=${info.name}`,
        `type=${info.type}`,
        `protocol=${info.protocolVersion}`,
    ].map(record => encoder.encode(record));
}


/**
 * Parse DNS-SD TXT records into an object of keys and values.
 *
 * @param {Uint8Array[]} records - The TXT records
 * @returns {object} The keys and values
 */
export function parseTxtRecords(records) {
    const decoder = new TextDecoder();
    const txt = {};

    for (const record of records) {
        const text = decoder.decode(record);
        const sep = text.indexOf('=');

        if (sep > 0)
            txt[text.slice(0, sep)] = text.slice(sep + 1);
    }

    return txt;
}


/**
 * Publishes this device as a KDE Connect service with mDNS and finds the other
 * KDE Connect devices on the network, through the Avahi daemon. This lets
 * devices find each other on networks that drop UDP broadcasts.
 *
 * Nothing happens if Avahi isn't running; it is picked up if it starts later.
 */
export const Dnssd = GObject.registerClass({
    GTypeName: 'GSConnectLanDnssd',
    Signals: {
        'service-found': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [
                GObject.TYPE_STRING, // device ID
                GObject.TYPE_STRING, // IP address
                GObject.TYPE_UINT,   // TCP port
            ],
        },
    },
}, class Dnssd extends GObject.Object {

    /**
     * @param {object} [params] - Parameters
     * @param {Gio.DBusConnection} [params.connection] - The bus Avahi is on
     */
    _init(params = {}) {
        super._init();

        this._connection = params.connection ?? Gio.DBus.system;
        this._info = null;
        this._watchId = 0;
        this._cancellable = null;
        this._publishing = Promise.resolve();

        this._groupPath = null;
        this._groupSignalId = 0;
        this._browserPath = null;
        this._browserSignalId = 0;

        // Discovered services, keyed by interface and name
        this._services = new Map();
    }

    /**
     * The devices found on the network.
     *
     * @type {Map<string, object>}
     */
    get services() {
        return this._services;
    }

    _call(objectPath, interfaceName, method, parameters = null) {
        return this._connection.call(
            AVAHI_NAME,
            objectPath,
            interfaceName,
            method,
            parameters,
            null,
            Gio.DBusCallFlags.NO_AUTO_START,
            -1,
            this._cancellable);
    }

    _subscribe(objectPath, interfaceName, callback) {
        return this._connection.signal_subscribe(
            AVAHI_NAME,
            interfaceName,
            null,
            objectPath,
            null,
            Gio.DBusSignalFlags.NONE,
            (connection, sender, path, iface, signal, parameters) => {
                callback(signal, parameters.deepUnpack());
            });
    }

    _buildService() {
        return new GLib.Variant('(iiussssqaay)', [
            AVAHI_IF_UNSPEC,
            AVAHI_PROTO_UNSPEC,
            0,
            this._info.id,
            SERVICE_TYPE,
            '',
            '',
            this._info.port,
            buildTxtRecords(this._info),
        ]);
    }

    /**
     * Publish the service, or update it if it was published already. Calls
     * are queued so that updates don't interleave.
     *
     * @returns {Promise} A promise for the publication
     */
    _publish() {
        this._publishing = this._publishing
            .catch(() => {})
            .then(() => this._publishService());

        return this._publishing;
    }

    async _publishService() {
        if (this._groupPath === null) {
            const reply = await this._call('/', AVAHI_SERVER_IFACE,
                'EntryGroupNew');
            [this._groupPath] = reply.deepUnpack();

            this._groupSignalId = this._subscribe(this._groupPath,
                AVAHI_ENTRY_GROUP_IFACE, (signal, [state, error]) => {
                    if (state === AVAHI_ENTRY_GROUP_COLLISION ||
                        state === AVAHI_ENTRY_GROUP_FAILURE)
                        debug(`Publishing failed: ${error}`, 'mDNS');
                });
        } else {
            await this._call(this._groupPath, AVAHI_ENTRY_GROUP_IFACE,
                'Reset');
        }

        await this._call(this._groupPath, AVAHI_ENTRY_GROUP_IFACE,
            'AddService', this._buildService());
        await this._call(this._groupPath, AVAHI_ENTRY_GROUP_IFACE, 'Commit');
    }

    async _browse() {
        const reply = await this._call('/', AVAHI_SERVER_IFACE,
            'ServiceBrowserPrepare', new GLib.Variant('(iissu)', [
                AVAHI_IF_UNSPEC,
                AVAHI_PROTO_INET,
                SERVICE_TYPE,
                '',
                0,
            ]));
        [this._browserPath] = reply.deepUnpack();

        // Subscribe before starting the browser, so no result is missed
        this._browserSignalId = this._subscribe(this._browserPath,
            AVAHI_SERVICE_BROWSER_IFACE, this._onBrowserSignal.bind(this));

        await this._call(this._browserPath, AVAHI_SERVICE_BROWSER_IFACE,
            'Start');
    }

    _onBrowserSignal(signal, args) {
        switch (signal) {
            case 'ItemNew':
                this._resolve(...args);
                break;

            case 'ItemRemove': {
                const [iface, , name] = args;
                this._services.delete(`${iface}:${name}`);
                break;
            }

            case 'Failure':
                debug(`Browsing failed: ${args[0]}`, 'mDNS');
                break;
        }
    }

    async _resolve(iface, protocol, name, type, domain) {
        try {
            // The service name is the device ID
            if (name === this._info.id)
                return;

            const reply = await this._call('/', AVAHI_SERVER_IFACE,
                'ResolveService', new GLib.Variant('(iisssiu)', [
                    iface,
                    protocol,
                    name,
                    type,
                    domain,
                    AVAHI_PROTO_INET,
                    0,
                ]));

            // eslint-disable-next-line no-unused-vars
            const [, , , , , host, , address, port, records] = reply.deepUnpack();
            const txt = parseTxtRecords(records);
            const id = txt.id ?? name;

            if (id === this._info.id)
                return;

            const key = `${iface}:${name}`;
            const known = this._services.get(key);

            if (known?.address === address && known?.port === port)
                return;

            this._services.set(key, {id, address, port, name: txt.name});
            this.emit('service-found', id, address, port);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, `mDNS: ${name}`);
        }
    }

    async _onAvahiAppeared() {
        this._reset();
        this._cancellable = new Gio.Cancellable();

        try {
            await this._publish();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, 'mDNS');
        }

        try {
            await this._browse();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, 'mDNS');
        }
    }

    /**
     * Forget Avahi's objects, freeing them if Avahi is still running.
     */
    _reset() {
        this._cancellable?.cancel();
        this._cancellable = null;

        if (this._groupSignalId) {
            this._connection.signal_unsubscribe(this._groupSignalId);
            this._groupSignalId = 0;
        }

        if (this._browserSignalId) {
            this._connection.signal_unsubscribe(this._browserSignalId);
            this._browserSignalId = 0;
        }

        for (const [path, iface] of [
            [this._groupPath, AVAHI_ENTRY_GROUP_IFACE],
            [this._browserPath, AVAHI_SERVICE_BROWSER_IFACE],
        ]) {
            if (path === null)
                continue;

            this._connection.call(AVAHI_NAME, path, iface, 'Free', null,
                null, Gio.DBusCallFlags.NO_AUTO_START, -1, null, null);
        }

        this._groupPath = null;
        this._browserPath = null;
        this._services.clear();
    }

    /**
     * Start publishing this device and looking for others.
     *
     * @param {object} info - The service information
     * @param {string} info.id - The device ID
     * @param {string} info.name - The device name
     * @param {string} info.type - The device type
     * @param {number} info.protocolVersion - The protocol version
     * @param {number} info.port - The TCP port
     */
    start(info) {
        this._info = {...info};

        if (this._watchId !== 0)
            return;

        this._watchId = Gio.bus_watch_name_on_connection(
            this._connection,
            AVAHI_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._onAvahiAppeared(),
            () => this._reset()
        );
    }

    /**
     * Update the published service information, such as the device name.
     *
     * @param {object} info - The service information, as for start()
     */
    async update(info) {
        this._info = {...info};

        if (this._groupPath === null)
            return;

        try {
            await this._publish();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, 'mDNS');
        }
    }

    /**
     * Stop publishing this device and looking for others.
     */
    stop() {
        if (this._watchId !== 0) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }

        this._reset();
    }

    destroy() {
        this.stop();
    }
});
