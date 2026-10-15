// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Plugin from '../plugin.js';


export const Metadata = {
    label: _('Run Commands'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.RunCommand',
    description: _('Run commands on your paired device or let the device run predefined commands on this PC'),
    incomingCapabilities: [
        'kdeconnect.runcommand',
        'kdeconnect.runcommand.request',
    ],
    outgoingCapabilities: [
        'kdeconnect.runcommand',
        'kdeconnect.runcommand.output',
        'kdeconnect.runcommand.request',
    ],
    actions: {
        commands: {
            label: _('Commands'),
            icon_name: 'system-run-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: ['kdeconnect.runcommand'],
            outgoing: ['kdeconnect.runcommand.request'],
        },
        executeCommand: {
            label: _('Commands'),
            icon_name: 'system-run-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: ['kdeconnect.runcommand'],
            outgoing: ['kdeconnect.runcommand.request'],
        },
    },
};


/**
 * The maximum number of output lines sent in one packet, matching KDE Connect.
 */
const OUTPUT_BATCH_LINES = 5;

/**
 * How long to wait for more output before sending a partial batch, in ms.
 */
const OUTPUT_FLUSH_DELAY = 100;


/**
 * RunCommand Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/remotecommands
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/runcommand
 */
const RunCommandPlugin = GObject.registerClass({
    GTypeName: 'GSConnectRunCommandPlugin',
    Properties: {
        'remote-commands': GObject.param_spec_variant(
            'remote-commands',
            'Remote Command List',
            'A list of the device\'s remote commands',
            new GLib.VariantType('a{sv}'),
            null,
            GObject.ParamFlags.READABLE
        ),
    },
}, class RunCommandPlugin extends Plugin {

    _init(device) {
        super._init(device, 'runcommand');

        // Local Commands
        this._commandListChangedId = this.settings.connect(
            'changed::command-list',
            this._sendCommandList.bind(this)
        );

        // We cache remote commands so they can be used in the settings even
        // when the device is offline.
        this._remote_commands = {};
        this.cacheProperties(['_remote_commands']);

        // Commands the device started, by the ID sent with their output
        this._processes = new Map();
        this._nextProcessId = 0;
        this._cancellable = new Gio.Cancellable();
    }

    get remote_commands() {
        return this._remote_commands;
    }

    connected() {
        super.connected();

        this._sendCommandList();
        this._requestCommandList();
        this._handleCommandList(this.remote_commands);
    }

    clearCache() {
        this._remote_commands = {};
        this.notify('remote-commands');
    }

    cacheLoaded() {
        if (!this.device.connected)
            return;

        this._sendCommandList();
        this._requestCommandList();
        this._handleCommandList(this.remote_commands);
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.runcommand':
                this._handleCommandList(packet.body.commandList);
                break;

            case 'kdeconnect.runcommand.request':
                if (packet.body.hasOwnProperty('key'))
                    this._handleCommand(packet.body.key);

                else if (packet.body.hasOwnProperty('requestCommandList'))
                    this._sendCommandList();

                else if (packet.body.hasOwnProperty('stop'))
                    this._stopCommands();

                break;
        }
    }

    /**
     * Handle a request to execute the local command with the UUID {@link key}
     *
     * @param {string} key - The UUID of the local command
     */
    _handleCommand(key) {
        try {
            const commands = this.settings.get_value('command-list');
            const commandList = commands.recursiveUnpack();

            if (!commandList.hasOwnProperty(key)) {
                throw new Gio.IOErrorEnum({
                    code: Gio.IOErrorEnum.PERMISSION_DENIED,
                    message: `Unknown command: ${key}`,
                });
            }

            const command = commandList[key].command;
            const proc = this.device.launchProcess(
                ['/bin/sh', '-c', command],
                null,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            this._reportCommand(proc, command);
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    /**
     * Send a running command's output and exit status to the device, which
     * shows them to the user.
     *
     * @param {Gio.Subprocess} proc - The command's process
     * @param {string} command - The command line
     */
    async _reportCommand(proc, command) {
        const id = this._nextProcessId++;
        this._processes.set(id, proc);

        try {
            this._sendOutput({commandStarted: true, command: command, id: id});

            await Promise.all([
                this._readOutput(id, proc.get_stdout_pipe(), 'stdout'),
                this._readOutput(id, proc.get_stderr_pipe(), 'stderr'),
            ]);
            await proc.wait_async(this._cancellable);

            this._sendOutput({
                commandFinished: true,
                success: proc.get_successful(),
                exitCode: proc.get_if_exited() ? proc.get_exit_status() : -1,
                id: id,
            });
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, this.device.name);
        } finally {
            this._processes.delete(id);
        }
    }

    /**
     * Read one of a command's output streams line by line, sending the lines
     * in small batches.
     *
     * @param {number} id - The ID of the command
     * @param {Gio.InputStream} stream - The command's stdout or stderr
     * @param {string} name - Either `stdout` or `stderr`
     */
    async _readOutput(id, stream, name) {
        const dataStream = new Gio.DataInputStream({base_stream: stream});
        const decoder = new TextDecoder();
        let lines = [];
        let flushId = 0;

        const flush = () => {
            if (flushId !== 0) {
                GLib.Source.remove(flushId);
                flushId = 0;
            }

            if (lines.length === 0)
                return;

            this._sendOutput({
                commandOutput: true,
                stdout: name === 'stdout' ? lines : [],
                stderr: name === 'stderr' ? lines : [],
                id: id,
            });
            lines = [];
        };

        const scheduleFlush = () => {
            if (flushId !== 0)
                return;

            flushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                OUTPUT_FLUSH_DELAY, () => {
                    flushId = 0;
                    flush();
                    return GLib.SOURCE_REMOVE;
                });
        };

        try {
            let line;

            while ((line = await this._readLine(dataStream)) !== null) {
                lines.push(decoder.decode(line));

                if (lines.length >= OUTPUT_BATCH_LINES)
                    flush();
                else
                    scheduleFlush();
            }
        } finally {
            flush();
            dataStream.close(null);
        }
    }

    /**
     * Read a line as bytes, since command output isn't always valid UTF-8.
     *
     * @param {Gio.DataInputStream} stream - The stream to read from
     * @returns {Promise<Uint8Array|null>} The line, or %null at the end
     */
    _readLine(stream) {
        return new Promise((resolve, reject) => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                (_stream, res) => {
                    try {
                        resolve(stream.read_line_finish(res)[0]);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _sendOutput(body) {
        this.device.sendPacket({
            type: 'kdeconnect.runcommand.output',
            body: body,
        });
    }

    /**
     * Stop the local commands the device started.
     */
    _stopCommands() {
        for (const proc of this._processes.values())
            proc.send_signal(15); // SIGTERM
    }

    /**
     * Parse the response to a request for the remote command list. Remove the
     * command menu if there are no commands, otherwise amend the menu.
     *
     * @param {string | object[]} commandList - A list of remote commands
     */
    _handleCommandList(commandList) {
        // See: https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues/1051
        if (typeof commandList === 'string') {
            try {
                commandList = JSON.parse(commandList);
            } catch {
                commandList = {};
            }
        }

        this._remote_commands = commandList;
        this.notify('remote-commands');

        const commandEntries = Object.entries(this.remote_commands);

        // If there are no commands, hide the menu by disabling the action
        this.device.lookup_action('commands').enabled = (commandEntries.length > 0);

        // Commands Submenu
        const submenu = new Gio.Menu();

        for (const [uuid, info] of commandEntries) {
            const item = new Gio.MenuItem();
            item.set_label(info.name);
            item.set_icon(
                new Gio.ThemedIcon({name: 'application-x-executable-symbolic'})
            );
            item.set_detailed_action(`device.executeCommand::${uuid}`);
            submenu.append_item(item);
        }

        // Commands Item
        const item = new Gio.MenuItem();
        item.set_detailed_action('device.commands::menu');
        item.set_attribute_value(
            'hidden-when',
            new GLib.Variant('s', 'action-disabled')
        );
        item.set_icon(new Gio.ThemedIcon({name: 'system-run-symbolic'}));
        item.set_label(_('Commands'));
        item.set_submenu(submenu);

        // If the submenu item is already present it will be replaced
        const menuActions = this.device.settings.get_strv('menu-actions');
        const index = menuActions.indexOf('commands');

        if (index > -1) {
            this.device.removeMenuAction('device.commands');
            this.device.addMenuItem(item, index);
        }
    }

    /**
     * Send a request for the remote command list
     */
    _requestCommandList() {
        this.device.sendPacket({
            type: 'kdeconnect.runcommand.request',
            body: {requestCommandList: true},
        });
    }

    /**
     * Send the local command list
     */
    _sendCommandList() {
        const commands = this.settings.get_value('command-list').recursiveUnpack();
        const commandList = JSON.stringify(commands);

        this.device.sendPacket({
            type: 'kdeconnect.runcommand',
            body: {commandList: commandList},
        });
    }

    /**
     * Placeholder function for command action
     */
    commands() {}

    /**
     * Send a request to execute the remote command with the UUID {@link key}
     *
     * @param {string} key - The UUID of the remote command
     */
    executeCommand(key) {
        this.device.sendPacket({
            type: 'kdeconnect.runcommand.request',
            body: {key: key},
        });
    }

    destroy() {
        this._cancellable.cancel();
        this.settings.disconnect(this._commandListChangedId);

        super.destroy();
    }
});

export default RunCommandPlugin;
