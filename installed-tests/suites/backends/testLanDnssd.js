// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import '../fixtures/utils.js';

import Config from '../config.js';
const Dnssd = await import(`file://${Config.PACKAGE_DATADIR}/service/backends/dnssd.js`);


const SERVER_XML = `
<node>
  <interface name="org.freedesktop.Avahi.Server2">
    <method name="EntryGroupNew">
      <arg name="path" type="o" direction="out"/>
    </method>
    <method name="ServiceBrowserPrepare">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="type" type="s" direction="in"/>
      <arg name="domain" type="s" direction="in"/>
      <arg name="flags" type="u" direction="in"/>
      <arg name="path" type="o" direction="out"/>
    </method>
    <method name="ResolveService">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="type" type="s" direction="in"/>
      <arg name="domain" type="s" direction="in"/>
      <arg name="aprotocol" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>
      <arg name="interface" type="i" direction="out"/>
      <arg name="protocol" type="i" direction="out"/>
      <arg name="name" type="s" direction="out"/>
      <arg name="type" type="s" direction="out"/>
      <arg name="domain" type="s" direction="out"/>
      <arg name="host" type="s" direction="out"/>
      <arg name="aprotocol" type="i" direction="out"/>
      <arg name="address" type="s" direction="out"/>
      <arg name="port" type="q" direction="out"/>
      <arg name="txt" type="aay" direction="out"/>
      <arg name="flags" type="u" direction="out"/>
    </method>
  </interface>
</node>`;

const ENTRY_GROUP_XML = `
<node>
  <interface name="org.freedesktop.Avahi.EntryGroup">
    <method name="Free"/>
    <method name="Commit"/>
    <method name="Reset"/>
    <method name="AddService">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="type" type="s" direction="in"/>
      <arg name="domain" type="s" direction="in"/>
      <arg name="host" type="s" direction="in"/>
      <arg name="port" type="q" direction="in"/>
      <arg name="txt" type="aay" direction="in"/>
    </method>
    <signal name="StateChanged">
      <arg name="state" type="i"/>
      <arg name="error" type="s"/>
    </signal>
  </interface>
</node>`;

const SERVICE_BROWSER_XML = `
<node>
  <interface name="org.freedesktop.Avahi.ServiceBrowser">
    <method name="Free"/>
    <method name="Start"/>
    <signal name="ItemNew">
      <arg name="interface" type="i"/>
      <arg name="protocol" type="i"/>
      <arg name="name" type="s"/>
      <arg name="type" type="s"/>
      <arg name="domain" type="s"/>
      <arg name="flags" type="u"/>
    </signal>
    <signal name="ItemRemove">
      <arg name="interface" type="i"/>
      <arg name="protocol" type="i"/>
      <arg name="name" type="s"/>
      <arg name="type" type="s"/>
      <arg name="domain" type="s"/>
      <arg name="flags" type="u"/>
    </signal>
  </interface>
</node>`;


/**
 * A minimal Avahi daemon, recording what it is asked to do.
 */
class FakeAvahi {
    constructor(connection) {
        this.connection = connection;
        this.services = [];
        this.calls = [];
        this.started = false;
        this.remote = new Map();

        this._server = Gio.DBusExportedObject.wrapJSObject(SERVER_XML, this);
        this._server.export(connection, '/');

        this.group = Gio.DBusExportedObject.wrapJSObject(ENTRY_GROUP_XML, {
            Free: () => this.calls.push('Free group'),
            Commit: () => this.calls.push('Commit'),
            Reset: () => {
                this.calls.push('Reset');
                this.services = [];
            },
            AddService: (...args) => {
                this.calls.push('AddService');
                this.services.push(args);
            },
        });
        this.group.export(connection, '/Client1/EntryGroup1');

        this.browser = Gio.DBusExportedObject.wrapJSObject(SERVICE_BROWSER_XML, {
            Free: () => this.calls.push('Free browser'),
            Start: () => {
                this.started = true;
            },
        });
        this.browser.export(connection, '/Client1/ServiceBrowser1');
    }

    EntryGroupNew() {
        return '/Client1/EntryGroup1';
    }

    ServiceBrowserPrepare(iface, protocol, type) {
        this.browseType = type;
        this.browseProtocol = protocol;
        return '/Client1/ServiceBrowser1';
    }

    ResolveService(iface, protocol, name, type, domain) {
        const remote = this.remote.get(name);
        const encoder = new TextEncoder();

        return [iface, protocol, name, type, domain, `${name}.local`, 0,
            remote.address, remote.port,
            remote.txt.map(record => encoder.encode(record)), 0];
    }

    /**
     * Pretend a device appeared on the network.
     *
     * @param {string} name - The service name
     * @param {object} remote - The address, port and TXT records to resolve
     */
    addRemote(name, remote) {
        this.remote.set(name, remote);
        this.browser.emit_signal('ItemNew', new GLib.Variant('(iisssu)',
            [2, 0, name, Dnssd.SERVICE_TYPE, 'local', 0]));
    }

    removeRemote(name) {
        this.browser.emit_signal('ItemRemove', new GLib.Variant('(iisssu)',
            [2, 0, name, Dnssd.SERVICE_TYPE, 'local', 0]));
    }

    destroy() {
        this._server.unexport();
        this.group.unexport();
        this.browser.unexport();
    }
}


/**
 * Iterate the main loop until a condition is met.
 *
 * @param {() => boolean} condition - Returns true when done waiting
 */
async function waitFor(condition) {
    while (!condition())
        await Promise.idle(GLib.PRIORITY_DEFAULT);
}


describe('mDNS discovery', function () {
    const info = {
        id: 'local_device_id',
        name: 'Local Device',
        type: 'laptop',
        protocolVersion: 8,
        port: 1716,
    };

    let busProcess, serverConnection, clientConnection;
    let avahi, ownerId, dnssd;

    beforeAll(function () {
        // A private bus, so nothing is published on the real network
        busProcess = Gio.Subprocess.new(
            ['dbus-daemon', '--session', '--nofork', '--print-address=1'],
            Gio.SubprocessFlags.STDOUT_PIPE);
        const stdout = new Gio.DataInputStream({
            base_stream: busProcess.get_stdout_pipe(),
        });
        const [address] = stdout.read_line_utf8(null);

        const flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
            Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION;
        serverConnection = Gio.DBusConnection.new_for_address_sync(
            address, flags, null, null);
        clientConnection = Gio.DBusConnection.new_for_address_sync(
            address, flags, null, null);
    });

    afterAll(async function () {
        dnssd?.destroy();
        avahi?.destroy();
        Gio.bus_unown_name(ownerId);

        // Let pending calls finish before the bus goes away
        for (let i = 0; i < 10; i++)
            await Promise.idle(GLib.PRIORITY_DEFAULT_IDLE);

        busProcess.force_exit();
    });

    it('builds and parses KDE Connect TXT records', function () {
        const records = Dnssd.buildTxtRecords(info);

        expect(Dnssd.parseTxtRecords(records)).toEqual({
            id: 'local_device_id',
            name: 'Local Device',
            type: 'laptop',
            protocol: '8',
        });
    });

    it('waits for Avahi to start', async function () {
        dnssd = new Dnssd.Dnssd({connection: clientConnection});
        dnssd.start(info);

        avahi = new FakeAvahi(serverConnection);
        ownerId = Gio.bus_own_name_on_connection(serverConnection,
            'org.freedesktop.Avahi', Gio.BusNameOwnerFlags.NONE, null, null);

        await waitFor(() => avahi.started);
    });

    it('publishes this device', function () {
        expect(avahi.services.length).toBe(1);

        const [iface, protocol, flags, name, type, domain, host, port, txt] =
            avahi.services[0];
        expect([iface, protocol, flags]).toEqual([-1, -1, 0]);
        expect([name, type, domain, host]).toEqual(
            ['local_device_id', '_kdeconnect._udp', '', '']);
        expect(port).toBe(1716);
        expect(Dnssd.parseTxtRecords(txt).name).toBe('Local Device');
        expect(avahi.calls).toContain('Commit');
    });

    it('looks for KDE Connect devices over IPv4', function () {
        expect(avahi.browseType).toBe('_kdeconnect._udp');
        expect(avahi.browseProtocol).toBe(0);
    });

    it('reports the devices it finds', async function () {
        const found = [];
        const id = dnssd.connect('service-found', (obj, ...args) => {
            found.push(args);
        });

        avahi.addRemote('remote_device_id', {
            address: '192.0.2.10',
            port: 1716,
            txt: ['id=remote_device_id', 'name=Phone', 'type=phone',
                'protocol=8'],
        });

        await waitFor(() => found.length > 0);
        dnssd.disconnect(id);

        expect(found).toEqual([['remote_device_id', '192.0.2.10', 1716]]);
        expect([...dnssd.services.values()]).toEqual([{
            id: 'remote_device_id',
            address: '192.0.2.10',
            port: 1716,
            name: 'Phone',
        }]);
    });

    it('ignores its own service', async function () {
        spyOn(dnssd, 'emit');

        avahi.addRemote('local_device_id', {
            address: '192.0.2.1',
            port: 1716,
            txt: ['id=local_device_id'],
        });

        // Let the signal and any resolve go through
        for (let i = 0; i < 10; i++)
            await Promise.idle(GLib.PRIORITY_DEFAULT_IDLE);

        expect(dnssd.emit).not.toHaveBeenCalled();
    });

    it('forgets devices that leave', async function () {
        avahi.removeRemote('remote_device_id');

        await waitFor(() => dnssd.services.size === 0);
    });

    it('publishes the new name when it changes', async function () {
        avahi.calls = [];
        await dnssd.update({...info, name: 'Renamed Device'});

        expect(avahi.calls).toEqual(['Reset', 'AddService', 'Commit']);
        expect(Dnssd.parseTxtRecords(avahi.services[0][8]).name).toBe(
            'Renamed Device');
    });

    it('frees its Avahi objects when stopped', async function () {
        avahi.calls = [];
        dnssd.stop();

        await waitFor(() => avahi.calls.length === 2);
        expect(avahi.calls).toContain('Free group');
        expect(avahi.calls).toContain('Free browser');
    });
});
