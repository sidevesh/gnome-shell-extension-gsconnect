// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Utils from '../fixtures/utils.js';


describe('The lockdevice plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        await Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.lock',
                    'kdeconnect.lock.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.lock',
                    'kdeconnect.lock.request',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.lock',
                    'kdeconnect.lock.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.lock',
                    'kdeconnect.lock.request',
                ],
            },
        });
        testRig.setPaired(true);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin && remotePlugin) {
            spyOn(localPlugin, 'handlePacket').and.callThrough();
            spyOn(remotePlugin, 'handlePacket').and.callThrough();
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('lockdevice');
        remotePlugin = testRig.remoteDevice._plugins.get('lockdevice');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('sends its lock state when connected', async function () {
        testRig.setConnected(true);

        expect(localPlugin.device.get_action_enabled('lock')).toBeTrue();
        expect(remotePlugin.device.get_action_enabled('lock')).toBeTrue();
        expect(localPlugin.device.get_action_enabled('unlock')).toBeTrue();

        await remotePlugin.awaitPacket('kdeconnect.lock', {
            isLocked: false,
        });
        await remotePlugin.awaitPacket('kdeconnect.lock.request', {
            requestLocked: true,
        });

        expect(localPlugin.device.getMenuAction('device.lock')).toBeGreaterThan(-1);
    });

    it('sends its lock state when asked', async function () {
        localPlugin.device.sendPacket({
            type: 'kdeconnect.lock.request',
            body: {requestLocked: true},
        });

        await localPlugin.awaitPacket('kdeconnect.lock', {
            isLocked: false,
        });
    });

    it('can lock the remote device', async function () {
        localPlugin.device.activate_action('lock', null);

        await remotePlugin.awaitPacket('kdeconnect.lock.request', {
            setLocked: true,
        });
        await localPlugin.awaitPacket('kdeconnect.lock', {
            lockResult: true,
        });
        await localPlugin.awaitPacket('kdeconnect.lock', {
            isLocked: true,
        });

        expect(remotePlugin._session.locked).toBeTrue();
    });

    it('offers to unlock the remote device while it is locked', function () {
        const {device} = localPlugin;

        expect(device.getMenuAction('device.lock')).toBe(-1);
        expect(device.getMenuAction('device.unlock')).toBeGreaterThan(-1);
    });

    it('can unlock the remote device', async function () {
        localPlugin.device.activate_action('unlock', null);

        await remotePlugin.awaitPacket('kdeconnect.lock.request', {
            setLocked: false,
        });
        await localPlugin.awaitPacket('kdeconnect.lock', {
            isLocked: false,
        });

        expect(remotePlugin._session.locked).toBeFalse();

        // The menu offers to lock it again
        const {device} = localPlugin;
        expect(device.getMenuAction('device.lock')).toBeGreaterThan(-1);
        expect(device.getMenuAction('device.unlock')).toBe(-1);
    });

    it('sends its lock state when it changes', async function () {
        remotePlugin._session.update({locked: true});

        await localPlugin.awaitPacket('kdeconnect.lock', {
            isLocked: true,
        });
    });

    it('notifies when locking the remote device fails', async function () {
        spyOn(remotePlugin._session, 'lock').and.rejectWith(new Error('No'));
        spyOn(localPlugin.device, 'showNotification');

        localPlugin.lock();

        await localPlugin.awaitPacket('kdeconnect.lock', {
            lockResult: false,
        });

        expect(localPlugin.device.showNotification).toHaveBeenCalledWith(
            jasmine.objectContaining({id: 'lock-failed'}));
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('lock')).toBeFalse();
        expect(remotePlugin.device.get_action_enabled('lock')).toBeFalse();
        expect(localPlugin.device.get_action_enabled('unlock')).toBeFalse();
    });
});
