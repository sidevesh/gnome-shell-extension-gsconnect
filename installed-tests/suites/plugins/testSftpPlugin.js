// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const {default: Plugin} = await import(`file://${Config.PACKAGE_DATADIR}/service/plugin.js`);


const Packets = {
    response: {
        type: 'kdeconnect.sftp',
        body: {
            ip: '127.0.0.1',
            port: 2039,
            user: 'kdeconnect',
            password: 'remote-password',
            path: '/',
            multiPaths: [
                '/remote-directory',
            ],
            pathNames: [
                'Remote',
            ],
        },
    },
    error: {
        type: 'kdeconnect.sftp',
        body: {
            errorMessage: 'Error Message',
        },
    },
};


/**
 * Mocked packet handling for the test device
 *
 * @param {object} packet - a KDE Connect protocol packet
 */
function handlePacket(packet) {
    switch (packet.type) {
        case 'kdeconnect.sftp.request':
            this.sendPacket(Packets.response);
            break;
    }
}


describe('The sftp plugin', function () {
    let testRig;
    let localPlugin;
    let remoteDevice;

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: ['kdeconnect.sftp.request'],
                outgoingCapabilities: ['kdeconnect.sftp'],
            },
            remoteDevice: {
                incomingCapabilities: ['kdeconnect.sftp'],
                outgoingCapabilities: ['kdeconnect.sftp'],
            },
        });
        testRig.setPaired(true);

        remoteDevice = testRig.remoteDevice;
        remoteDevice.handlePacket = handlePacket.bind(remoteDevice);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin) {
            spyOn(localPlugin, 'handlePacket').and.callThrough();
            spyOn(localPlugin, '_handleMount');
            spyOn(localPlugin.device, 'showNotification');
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('sftp');

        expect(localPlugin).toBeDefined();
    });

    describe('bookmarks', function () {
        let bookmarksFile;

        const read = () => new TextDecoder().decode(
            bookmarksFile.load_contents(null)[1]);

        beforeAll(function () {
            const dir = GLib.dir_make_tmp('gsconnect.XXXXXX');
            bookmarksFile = Gio.File.new_for_path(
                GLib.build_filenamev([dir, 'gtk-3.0', 'bookmarks']));
            localPlugin.bookmarksFile = bookmarksFile;
        });

        it('creates the bookmarks file if needed', function () {
            localPlugin.toggleBookmark();

            const uri = localPlugin._getBookmarkUri();

            expect(uri).toMatch(/\/by-name\//);
            expect(read()).toBe(`${uri} ${localPlugin.device.name}\n`);
            expect(localPlugin.isBookmarked()).toBeTrue();
        });

        it('removes only its own bookmark', function () {
            const uri = localPlugin._getBookmarkUri();
            bookmarksFile.replace_contents(
                new TextEncoder().encode(
                    `file:///home Home\n${uri} Renamed\nfile:///tmp\n`),
                null, false, Gio.FileCreateFlags.NONE, null);

            localPlugin.toggleBookmark();

            expect(read()).toBe('file:///home Home\nfile:///tmp\n');
            expect(localPlugin.isBookmarked()).toBeFalse();
        });

        it('keeps other bookmarks when adding', function () {
            localPlugin.toggleBookmark();

            const uri = localPlugin._getBookmarkUri();

            expect(read()).toBe(
                `file:///home Home\nfile:///tmp\n${uri} ${localPlugin.device.name}\n`);
        });

        it('follows the device when it is renamed', function () {
            const device = localPlugin.device;
            const oldName = device.name;
            const oldUri = localPlugin._getBookmarkUri();

            device.settings.set_string('name', 'Renamed Phone');
            device.notify('name');

            const uri = localPlugin._getBookmarkUri();

            expect(uri).not.toBe(oldUri);
            expect(read()).toBe(
                `file:///home Home\nfile:///tmp\n${uri} Renamed Phone\n`);
            expect(localPlugin.isBookmarked()).toBeTrue();

            // A label the user chose is kept
            bookmarksFile.replace_contents(
                new TextEncoder().encode(`${uri} My Files\n`),
                null, false, Gio.FileCreateFlags.NONE, null);
            device.settings.set_string('name', oldName);
            device.notify('name');

            expect(read()).toBe(`${oldUri} My Files\n`);
        });
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        // NOTE: chaining-up to avoid the guard against Core.Channel type
        Plugin.prototype.connected.call(localPlugin);

        expect(localPlugin.device.get_action_enabled('mount')).toBeTrue();
        expect(localPlugin.device.get_action_enabled('unmount')).toBeTrue();
    });

    it('can request a mount', async function () {
        localPlugin.mount();

        await localPlugin.awaitPacket('kdeconnect.sftp', Packets.response.body);

        expect(localPlugin._handleMount).toHaveBeenCalled();
    });

    it('can handle error messages', async function () {
        remoteDevice.sendPacket(Packets.error);

        await localPlugin.awaitPacket('kdeconnect.sftp', Packets.error.body);

        expect(localPlugin.device.showNotification).toHaveBeenCalled();
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('mount')).toBeFalse();
        expect(localPlugin.device.get_action_enabled('unmount')).toBeFalse();
    });
});
