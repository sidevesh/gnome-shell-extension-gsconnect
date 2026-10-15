// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';

import * as Utils from '../fixtures/utils.js';


describe('The share plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;
    let receiveDir;

    /**
     * Wait for a device to show a notification with a title.
     *
     * @param {object} device - The device, with a spy on showNotification
     * @param {string} title - The notification title
     * @returns {Promise<object>} The notification parameters
     */
    async function awaitNotification(device, title) {
        while (true) {
            const call = device.showNotification.calls.allArgs()
                .find(([params]) => params.title === title);

            if (call)
                return call[0];

            await Promise.idle(GLib.PRIORITY_DEFAULT);
        }
    }

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.share.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.share.request',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.share.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.share.request',
                ],
            },
        });
        testRig.setPaired(true);

        receiveDir = GLib.dir_make_tmp('gsconnect.XXXXXX');
    });

    afterAll(function () {
        testRig.destroy();
        GLib.spawn_command_line_sync(`rm -rf ${receiveDir}`);
    });

    beforeEach(function () {
        if (remotePlugin)
            spyOn(remotePlugin, 'handlePacket').and.callThrough();

        // Adding recent files needs a display
        spyOn(Gtk.RecentManager, 'get_default').and.returnValue(
            jasmine.createSpyObj('RecentManager', ['add_item']));
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('share');
        remotePlugin = testRig.remoteDevice._plugins.get('share');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();

        remotePlugin.settings.set_string('receive-directory', receiveDir);
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        for (const action in localPlugin._meta.actions)
            expect(localPlugin.device.get_action_enabled(action)).toBeTrue();

        for (const action in remotePlugin._meta.actions)
            expect(remotePlugin.device.get_action_enabled(action)).toBeTrue();
    });

    it('can send and receive files', async function () {
        spyOn(remotePlugin, '_handleFile').and.callThrough();
        spyOn(localPlugin.device, 'showNotification').and.callThrough();
        spyOn(remotePlugin.device, 'showNotification').and.callThrough();

        localPlugin.shareFile(Utils.getDataPath('album.png'));

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            filename: 'album.png',
            numberOfFiles: 1,
        });

        expect(remotePlugin._handleFile).toHaveBeenCalled();

        const received = await awaitNotification(remotePlugin.device,
            'Transfer Successful');
        expect(received.body).toContain('“album.png”');

        const sent = await awaitNotification(localPlugin.device,
            'Transfer Successful');
        expect(sent.body).toContain('“album.png”');

        expect(GLib.file_test(`${receiveDir}/album.png`,
            GLib.FileTest.EXISTS)).toBeTrue();
    });

    it('sends files shared together as one batch', async function () {
        spyOn(localPlugin.device, 'showNotification').and.callThrough();
        spyOn(remotePlugin.device, 'showNotification').and.callThrough();

        const path = Utils.getDataPath('album.png');
        const size = Utils.getDataFile('album.png')
            .query_info('standard::size', 0, null).get_size();

        localPlugin.shareFile(path);
        localPlugin.shareFile(path);
        localPlugin.shareFile(path);

        const received = await awaitNotification(remotePlugin.device,
            'Transfer Successful');
        expect(received.body).toBe(`Received 3 files from ${localPlugin.device.name}`);

        const sent = await awaitNotification(localPlugin.device,
            'Transfer Successful');
        expect(sent.body).toBe(`Sent 3 files to ${remotePlugin.device.name}`);

        const packets = remotePlugin.handlePacket.calls.allArgs()
            .map(([packet]) => packet)
            .filter(packet => packet.body.filename === 'album.png');
        expect(packets.length).toBe(3);

        for (const packet of packets) {
            expect(packet.body.numberOfFiles).toBe(3);
            expect(packet.body.totalPayloadSize).toBe(3 * size);
        }

        // One progress notification, updated as each file arrives
        const progress = remotePlugin.device.showNotification.calls.allArgs()
            .map(([params]) => params)
            .filter(params => params.title === 'Transferring File');
        expect(new Set(progress.map(params => params.id)).size).toBe(1);
        expect(progress.map(params => params.body)).toContain(
            `Receiving file 3 of 3 from ${localPlugin.device.name} (66%)`);
        expect(progress[0].priority).toBe(Gio.NotificationPriority.NORMAL);
        expect(progress.at(-1).priority).toBe(Gio.NotificationPriority.LOW);

        for (const name of ['album.png (1)', 'album.png (2)', 'album.png (3)']) {
            expect(GLib.file_test(`${receiveDir}/${name}`,
                GLib.FileTest.EXISTS)).toBeTrue();
        }
    });

    it('waits for slow files to join the batch', async function () {
        spyOn(remotePlugin.device, 'showNotification').and.callThrough();

        const queryInfo = Gio.File.prototype.query_info_async;
        let lookups = 0;

        // Looking up the last file takes longer than the other two together
        spyOn(Gio.File.prototype, 'query_info_async').and.callFake(
            async function (...args) {
                if (++lookups === 3) {
                    await new Promise(resolve => {
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                            resolve();
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                }

                return queryInfo.apply(this, args);
            });

        const path = Utils.getDataPath('album.png');
        localPlugin.shareFile(path);
        localPlugin.shareFile(path);
        localPlugin.shareFile(path);

        await awaitNotification(remotePlugin.device, 'Transfer Successful');

        const packets = remotePlugin.handlePacket.calls.allArgs()
            .map(([packet]) => packet)
            .filter(packet => packet.body.filename === 'album.png');
        expect(packets.length).toBe(3);

        for (const packet of packets)
            expect(packet.body.numberOfFiles).toBe(3);
    });

    it('tells the device about files added to a running batch', async function () {
        // Hold the first file so the batch is still running
        spyOn(remotePlugin, '_handleFile');

        const path = Utils.getDataPath('album.png');
        localPlugin.shareFile(path);

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            numberOfFiles: 1,
        });

        localPlugin.shareFile(path);

        await remotePlugin.awaitPacket('kdeconnect.share.request.update', {
            numberOfFiles: 2,
        });

        const batch = localPlugin._sendBatch;
        batch.transfer.cancel();

        while (localPlugin._sendBatch === batch)
            await Promise.idle(GLib.PRIORITY_DEFAULT);
    });

    it('starts a new batch when the last one was abandoned', async function () {
        spyOn(remotePlugin.device, 'showNotification').and.callThrough();

        const abandoned = remotePlugin._createBatch(5, 0);
        abandoned.files.push(null, null);
        abandoned.lastActivity = GLib.get_monotonic_time() - 60 * GLib.USEC_PER_SEC;
        remotePlugin._receiveBatch = abandoned;

        localPlugin.shareFile(Utils.getDataPath('album.png'));

        const failed = await awaitNotification(remotePlugin.device,
            'Transfer Failed');
        expect(failed.id).toBe(abandoned.id);
        expect(failed.body).toBe(`Received 2 of 5 files from ${localPlugin.device.name}`);

        const received = await awaitNotification(remotePlugin.device,
            'Transfer Successful');
        expect(received.id).not.toBe(abandoned.id);
        expect(received.body).toContain('“album.png”');
    });

    it('updates the totals of a batch it is receiving', function () {
        spyOn(remotePlugin.device, 'showNotification');
        spyOn(remotePlugin.device, 'hideNotification');

        const batch = remotePlugin._createBatch(2, 100);
        batch.files.push(null);
        batch.transferredSize = 50;
        remotePlugin._receiveBatch = batch;

        remotePlugin.handlePacket({
            type: 'kdeconnect.share.request.update',
            body: {numberOfFiles: 4, totalPayloadSize: 200},
        });

        expect(batch.numberOfFiles).toBe(4);
        expect(batch.totalPayloadSize).toBe(200);
        expect(remotePlugin.device.showNotification).toHaveBeenCalledWith(
            jasmine.objectContaining({
                id: batch.id,
                body: `Receiving file 2 of 4 from ${localPlugin.device.name} (25%)`,
            }));

        remotePlugin._receiveBatch = null;
    });

    it('can send and receive text', async function () {
        spyOn(remotePlugin, '_handleText');

        localPlugin.shareText('shared text');

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            text: 'shared text',
        });

        expect(remotePlugin._handleText).toHaveBeenCalled();
    });

    it('treats URIs as text by default', async function () {
        spyOn(remotePlugin, '_handleText');

        localPlugin.shareUri('https://www.gnome.org/');

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            url: 'https://www.gnome.org/',
        });

        expect(remotePlugin._handleText).toHaveBeenCalled();
    });

    it('launches URIs directly when configured to do so', async function () {
        remotePlugin.settings.set_boolean('launch-urls', true);
        spyOn(remotePlugin, '_handleUri');

        localPlugin.shareUri('https://www.gnome.org/');

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            url: 'https://www.gnome.org/',
        });

        expect(remotePlugin._handleUri).toHaveBeenCalled();
        remotePlugin.settings.set_boolean('launch-urls', false);
    });

    it('also detects and launches URIs in text shares', async function () {
        remotePlugin.settings.set_boolean('launch-urls', true);
        spyOn(remotePlugin, '_handleUri');

        localPlugin.shareText('GTK Documentation https://docs.gtk.org/');

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            text: 'GTK Documentation https://docs.gtk.org/',
        });

        expect(remotePlugin._handleUri).toHaveBeenCalled();
        remotePlugin.settings.set_boolean('launch-urls', false);
    });

    xit('interprets file URIs as file shares', async function () {
        spyOn(remotePlugin, '_handleFile');

        localPlugin.shareUri('file:///home/user/file.ext');

        await remotePlugin.awaitPacket('kdeconnect.share.request', {
            filename: 'file.ext',
        });

        expect(remotePlugin._handleFile).toHaveBeenCalled();
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        for (const action in localPlugin._meta.actions)
            expect(localPlugin.device.get_action_enabled(action)).toBeFalse();

        for (const action in remotePlugin._meta.actions)
            expect(remotePlugin.device.get_action_enabled(action)).toBeFalse();
    });
});
