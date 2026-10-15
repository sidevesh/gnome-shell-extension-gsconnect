// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';


describe('The runcommand plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.runcommand',
                    'kdeconnect.runcommand.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.runcommand',
                    'kdeconnect.runcommand.request',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.runcommand',
                    'kdeconnect.runcommand.output',
                    'kdeconnect.runcommand.request',
                ],
                outgoingCapabilities: [
                    'kdeconnect.runcommand',
                    'kdeconnect.runcommand.request',
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

        localPlugin = testRig.localDevice._plugins.get('runcommand');
        remotePlugin = testRig.remoteDevice._plugins.get('runcommand');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        expect(localPlugin.device.get_action_enabled('executeCommand')).toBeTrue();
        expect(remotePlugin.device.get_action_enabled('executeCommand')).toBeTrue();
    });

    it('sends and request the list of commands when connected', async function () {
        localPlugin.connected();

        await remotePlugin.awaitPacket('kdeconnect.runcommand.request', {
            requestCommandList: true,
        });

        await remotePlugin.awaitPacket('kdeconnect.runcommand', {
            commandList: {},
        });
    });

    it('sends the command list when it changes', async function () {
        const commandList = new GLib.Variant('a{sv}', {
            'command-uuid': new GLib.Variant('a{ss}', {
                name: 'Test Command',
                command: 'ls',
            }),
        });

        localPlugin.settings.set_value('command-list', commandList);

        await remotePlugin.awaitPacket('kdeconnect.runcommand', {
            commandList: '{"command-uuid":{"name":"Test Command","command":"ls"}}',
        });

        expect(remotePlugin.remote_commands['command-uuid']).toBeDefined();
    });

    it('can activate a remote command', async function () {
        spyOn(localPlugin.device, 'launchProcess').and.callThrough();
        remotePlugin.executeCommand('command-uuid');

        await localPlugin.awaitPacket('kdeconnect.runcommand.request', {
            key: 'command-uuid',
        });

        expect(localPlugin.device.launchProcess).toHaveBeenCalled();
    });

    /**
     * Get the bodies of the output packets the remote device received for a
     * command, in order.
     *
     * @param {string} command - The command line
     * @returns {object[]} The packet bodies
     */
    function getCommandOutput(command) {
        const bodies = remotePlugin.device.handlePacket.calls.allArgs()
            .map(([packet]) => packet)
            .filter(packet => packet.type === 'kdeconnect.runcommand.output')
            .map(packet => packet.body);
        const {id} = bodies.find(body => body.command === command);

        return bodies.filter(body => body.id === id);
    }

    it('sends the output and result of a command it runs', async function () {
        const commandList = new GLib.Variant('a{sv}', {
            'output-uuid': new GLib.Variant('a{ss}', {
                name: 'Output Command',
                command: 'echo one; echo two; echo oops >&2; exit 3',
            }),
        });
        localPlugin.settings.set_value('command-list', commandList);
        spyOn(remotePlugin.device, 'handlePacket').and.callThrough();

        remotePlugin.executeCommand('output-uuid');

        await remotePlugin.device.awaitPacket('kdeconnect.runcommand.output', {
            commandFinished: true,
            exitCode: 3,
        });

        const bodies = getCommandOutput(
            'echo one; echo two; echo oops >&2; exit 3');
        expect(bodies[0].commandStarted).toBeTrue();

        const outputs = bodies.filter(body => body.commandOutput);
        expect(outputs.flatMap(body => body.stdout)).toEqual(['one', 'two']);
        expect(outputs.flatMap(body => body.stderr)).toEqual(['oops']);

        expect(bodies.at(-1)).toEqual(jasmine.objectContaining({
            commandFinished: true,
            success: false,
            exitCode: 3,
        }));
    });

    it('sends long output in batches of five lines', async function () {
        const commandList = new GLib.Variant('a{sv}', {
            'batch-uuid': new GLib.Variant('a{ss}', {
                name: 'Batch Command',
                command: 'seq 12',
            }),
        });
        localPlugin.settings.set_value('command-list', commandList);
        spyOn(remotePlugin.device, 'handlePacket').and.callThrough();

        remotePlugin.executeCommand('batch-uuid');

        await remotePlugin.device.awaitPacket('kdeconnect.runcommand.output', {
            command: 'seq 12',
        });

        const stdout = [];

        while (!getCommandOutput('seq 12').at(-1).commandFinished)
            await Promise.idle(GLib.PRIORITY_DEFAULT);

        for (const body of getCommandOutput('seq 12')) {
            if (body.commandOutput)
                stdout.push(body.stdout);
        }

        expect(stdout.every(lines => lines.length <= 5)).toBeTrue();
        expect(stdout.flat()).toEqual(
            Array.from({length: 12}, (_, i) => `${i + 1}`));
    });

    it('stops running commands when asked', async function () {
        const commandList = new GLib.Variant('a{sv}', {
            'sleep-uuid': new GLib.Variant('a{ss}', {
                name: 'Sleep Command',
                command: 'exec sleep 30',
            }),
        });
        localPlugin.settings.set_value('command-list', commandList);
        spyOn(remotePlugin.device, 'handlePacket').and.callThrough();

        remotePlugin.executeCommand('sleep-uuid');
        await remotePlugin.device.awaitPacket('kdeconnect.runcommand.output', {
            commandStarted: true,
        });

        remotePlugin.device.sendPacket({
            type: 'kdeconnect.runcommand.request',
            body: {stop: true},
        });

        await remotePlugin.device.awaitPacket('kdeconnect.runcommand.output', {
            commandFinished: true,
            success: false,
        });
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('executeCommand')).toBeFalse();
        expect(remotePlugin.device.get_action_enabled('executeCommand')).toBeFalse();
    });
});

