// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';


describe('The shareinputdevices plugin', function () {
    let testRig;
    let localPlugin, remoteDevice;

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            // The local device is described by the phone's capabilities, like
            // KDE Connect for Android's "Receive input devices" plugin
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.mousepad.request',
                    'kdeconnect.shareinputdevices.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.shareinputdevices',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.shareinputdevices',
                ],
                outgoingCapabilities: [
                    'kdeconnect.mousepad.request',
                    'kdeconnect.shareinputdevices.request',
                ],
            },
        });
        testRig.setPaired(true);

        remoteDevice = testRig.remoteDevice;
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        spyOn(remoteDevice, 'handlePacket');

        if (localPlugin)
            spyOn(localPlugin, 'handlePacket').and.callThrough();
    });

    it('is disabled by default', function () {
        const {settings} = testRig.localDevice;

        expect(settings.get_strv('supported-plugins')).toContain('shareinputdevices');
        expect(settings.get_strv('disabled-plugins')).toContain('shareinputdevices');
    });

    it('can be loaded once enabled', async function () {
        testRig.localDevice.settings.set_strv('disabled-plugins', []);
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('shareinputdevices');
        expect(localPlugin).toBeDefined();
    });

    it('enables its GActions when connected', async function () {
        await testRig.setConnected(true);

        for (const name of ['shareInputEnter', 'shareInputEvents',
            'shareInputEdge', 'shareInputRelease'])
            expect(localPlugin.device.get_action_enabled(name)).withContext(name).toBeTrue();
    });

    it('exposes the configured edge', function () {
        const {device} = localPlugin;

        expect(device.get_action_state('shareInputEdge').unpack()).toBe('left');

        localPlugin.settings.set_string('edge', 'top');
        expect(device.get_action_state('shareInputEdge').unpack()).toBe('top');
    });

    it('hands the pointer over at the configured edge', async function () {
        localPlugin.device.activate_action('shareInputEnter',
            new GLib.Variant('(dd)', [0, 312.4]));

        // Qt::TopEdge, as set in the previous test
        await remoteDevice.awaitPacket('kdeconnect.shareinputdevices.request', {
            exitEdge: 0x1,
            deltax: 0,
            deltay: 312,
        });

        localPlugin.settings.set_string('edge', 'left');
    });

    it('forwards input events, dropping unknown fields', async function () {
        localPlugin.device.activate_action('shareInputEvents',
            new GLib.Variant('s', JSON.stringify([
                {dx: 4, dy: -2},
                {singlehold: true},
                {key: 'a', shift: true, bogus: 1},
                {bogus: 1},
            ])));

        await remoteDevice.awaitPacket('kdeconnect.mousepad.request', {
            key: 'a',
        });

        const bodies = remoteDevice.handlePacket.calls.allArgs()
            .map(([packet]) => packet)
            .filter(packet => packet.type === 'kdeconnect.mousepad.request')
            .map(packet => packet.body);

        expect(bodies).toEqual([
            {dx: 4, dy: -2},
            {singlehold: true},
            {key: 'a', shift: true},
        ]);
    });

    it('ignores input that is not a JSON array', function () {
        localPlugin.device.activate_action('shareInputEvents',
            new GLib.Variant('s', 'not json'));
        localPlugin.device.activate_action('shareInputEvents',
            new GLib.Variant('s', '{"dx": 1}'));

        expect(remoteDevice.handlePacket).not.toHaveBeenCalled();
    });

    it('reports where the device handed the pointer back', async function () {
        const {device} = localPlugin;
        const [before] = device.get_action_state('shareInputRelease').deepUnpack();

        remoteDevice.sendPacket({
            type: 'kdeconnect.shareinputdevices',
            body: {releaseDeltax: 0, releaseDeltay: 640},
        });

        await localPlugin.awaitPacket('kdeconnect.shareinputdevices');

        const [serial, dx, dy] = device.get_action_state('shareInputRelease')
            .deepUnpack();
        expect(serial).toBe(before + 1);
        expect([dx, dy]).toEqual([0, 640]);
    });

    it('disables its GActions when disconnected', async function () {
        await testRig.setConnected(false);

        for (const name of ['shareInputEnter', 'shareInputEvents',
            'shareInputEdge', 'shareInputRelease'])
            expect(localPlugin.device.get_action_enabled(name)).withContext(name).toBeFalse();
    });
});
