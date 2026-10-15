// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import Plugin from '../plugin.js';
import * as URI from '../utils/uri.js';


export const Metadata = {
    label: _('Share'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Share',
    description: _('Share files and URLs between devices'),
    incomingCapabilities: [
        'kdeconnect.share.request',
        'kdeconnect.share.request.update',
    ],
    outgoingCapabilities: [
        'kdeconnect.share.request',
        'kdeconnect.share.request.update',
    ],
    actions: {
        share: {
            label: _('Share'),
            icon_name: 'send-to-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.share.request'],
        },
        shareFile: {
            label: _('Share File'),
            icon_name: 'document-send-symbolic',

            parameter_type: new GLib.VariantType('(sb)'),
            incoming: [],
            outgoing: ['kdeconnect.share.request'],
        },
        shareText: {
            label: _('Share Text'),
            icon_name: 'send-to-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.share.request'],
        },
        shareUri: {
            label: _('Share Link'),
            icon_name: 'send-to-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.share.request'],
        },
    },
};


/**
 * How long a batch being received waits for its next file before a new file
 * starts a new batch, in microseconds. Devices send the next file as soon as
 * the last one is done, so a longer gap means the batch was abandoned.
 */
const BATCH_IDLE_TIMEOUT = 10 * GLib.USEC_PER_SEC;


/**
 * Share Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/share
 *
 * TODO: receiving 'text' TODO: Window with textview & 'Copy to Clipboard..
 *       https://github.com/KDE/kdeconnect-kde/commit/28f11bd5c9a717fb9fbb3f02ddd6cea62021d055
 */
const SharePlugin = GObject.registerClass({
    GTypeName: 'GSConnectSharePlugin',
}, class SharePlugin extends Plugin {

    _init(device) {
        super._init(device, 'share');

        // The batches of files being received and sent. Files shared together
        // are transferred one after another and reported in one notification.
        this._receiveBatch = null;
        this._sendBatch = null;
        this._pendingShares = 0;
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.share.request.update') {
            this._handleUpdate(packet);
            return;
        }

        const {filename, text, url} = packet.body;

        if (filename !== undefined) {
            debug(`Remote wants to share file "${filename}".`);
            if (this.settings.get_boolean('receive-files'))
                this._handleFile(packet);
            else
                this._refuseFile(packet);
            return;
        }
        if (text === undefined && url === undefined)
            throw new Error('Share request has invalid payload, ignoring.');

        if (this.settings.get_boolean('launch-urls')) {
            let shared_url = url;
            if (url === undefined) {
                const urls = URI.findUrls(text);
                if (urls.length === 1)
                    shared_url = urls[0].url;
            }
            if (shared_url !== undefined) {
                debug(`Launching shared URL "${shared_url}".`);
                return this._handleUri(shared_url);
            }
        }
        const message = text || url;
        debug('Displaying shared message.');
        this._handleText(message);
    }

    _ensureReceiveDirectory() {
        let receiveDir = this.settings.get_string('receive-directory');

        // Ensure a directory is set
        if (receiveDir.length === 0) {
            receiveDir = GLib.get_user_special_dir(
                GLib.UserDirectory.DIRECTORY_DOWNLOAD
            );

            // Fallback to ~/Downloads
            const homeDir = GLib.get_home_dir();

            if (!receiveDir || receiveDir === homeDir)
                receiveDir = GLib.build_filenamev([homeDir, 'Downloads']);

            this.settings.set_string('receive-directory', receiveDir);
        }

        // Ensure the directory exists
        if (!GLib.file_test(receiveDir, GLib.FileTest.IS_DIR))
            GLib.mkdir_with_parents(receiveDir, 448);

        return receiveDir;
    }

    _getFile(filename) {
        const dirpath = this._ensureReceiveDirectory();

        // Remote-supplied filename is untrusted;
        // collapse to a basename so it can't escape the download dir
        // via '../' or an absolute path.
        let basename = GLib.path_get_basename(filename);
        if (!basename || basename === '.' || basename === '..' ||
            basename.includes('/'))
            basename = 'unnamed-file';

        const basepath = GLib.build_filenamev([dirpath, basename]);
        let filepath = basepath;
        let copyNum = 0;

        while (GLib.file_test(filepath, GLib.FileTest.EXISTS))
            filepath = `${basepath} (${++copyNum})`;

        return Gio.File.new_for_path(filepath);
    }

    _refuseFile(packet) {
        try {
            this.device.rejectTransfer(packet);

            this.device.showNotification({
                id: `${Date.now()}`,
                title: _('Transfer Failed'),
                // TRANSLATORS: eg. Google Pixel is not allowed to upload files
                body: _('%s is not allowed to upload files').format(
                    this.device.name
                ),
                icon: new Gio.ThemedIcon({name: 'dialog-error-symbolic'}),
            });
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    /**
     * Create a batch of file transfers, reported in one notification.
     *
     * @param {number} numberOfFiles - The number of files expected
     * @param {number} totalPayloadSize - The size of all the files, in bytes
     * @returns {object} The batch
     */
    _createBatch(numberOfFiles, totalPayloadSize) {
        return {
            id: GLib.uuid_string_random(),
            numberOfFiles: numberOfFiles,
            totalPayloadSize: totalPayloadSize,
            transferredSize: 0,
            files: [],
            transfer: null,
            notified: false,
        };
    }

    /**
     * Get the progress of a batch as a percentage.
     *
     * @param {object} batch - The batch
     * @returns {number} The progress, from 0 to 100
     */
    _getBatchProgress(batch) {
        if (batch.totalPayloadSize > 0) {
            return Math.min(100, Math.floor(
                batch.transferredSize * 100 / batch.totalPayloadSize));
        }

        return Math.floor(batch.files.length * 100 / batch.numberOfFiles);
    }

    /**
     * Show or update the notification for a batch in progress. Only the first
     * one pops up; updates replace it quietly.
     *
     * @param {object} batch - The batch
     * @param {string} title - The notification title
     * @param {string} body - The notification body
     * @param {string} iconName - The notification icon name
     */
    _showBatchProgress(batch, title, body, iconName) {
        const buttons = [];

        if (batch.transfer !== null) {
            buttons.push({
                label: _('Cancel'),
                action: 'cancelTransfer',
                parameter: new GLib.Variant('s', batch.transfer.uuid),
            });
        }

        // Notifications are only updated in place when the title or body
        // changes, so replace it to update the button too
        if (batch.notified)
            this.device.hideNotification(batch.id);

        this.device.showNotification({
            id: batch.id,
            title: title,
            body: body,
            buttons: buttons,
            icon: new Gio.ThemedIcon({name: iconName}),
            priority: batch.notified
                ? Gio.NotificationPriority.LOW
                : Gio.NotificationPriority.NORMAL,
        });
        batch.notified = true;
    }

    /**
     * Show the final notification for a batch.
     *
     * @param {object} batch - The batch
     * @param {object} params - The notification parameters
     */
    _showBatchResult(batch, params) {
        if (batch.notified)
            this.device.hideNotification(batch.id);

        this.device.showNotification({id: batch.id, ...params});
    }

    /**
     * Update the totals of the batch being received, when the device adds
     * more files to it.
     *
     * @param {object} packet - A `kdeconnect.share.request.update` packet
     */
    _handleUpdate(packet) {
        const batch = this._receiveBatch;

        if (batch === null)
            return;

        const {numberOfFiles, totalPayloadSize} = packet.body;

        if (Number.isInteger(numberOfFiles))
            batch.numberOfFiles = Math.max(batch.numberOfFiles, numberOfFiles);

        if (Number.isInteger(totalPayloadSize))
            batch.totalPayloadSize = Math.max(batch.totalPayloadSize, totalPayloadSize);

        this._showReceiveProgress(batch);
    }

    _showReceiveProgress(batch) {
        let body;

        if (batch.numberOfFiles === 1) {
            // TRANSLATORS: eg. Receiving 'book.pdf' from Google Pixel
            body = _('Receiving “%s” from %s').format(
                batch.filename,
                this.device.name
            );
        } else {
            // TRANSLATORS: eg. Receiving file 3 of 12 from Google Pixel (25%)
            body = _('Receiving file %d of %d from %s (%d%%)').format(
                Math.min(batch.files.length + 1, batch.numberOfFiles),
                batch.numberOfFiles,
                this.device.name,
                this._getBatchProgress(batch)
            );
        }

        this._showBatchProgress(batch, _('Transferring File'), body,
            'document-save-symbolic');
    }

    /**
     * Receive a file. Files the device sends together, with the total number
     * of files and their size, are received as one batch.
     *
     * @param {object} packet - A `kdeconnect.share.request` packet
     */
    async _handleFile(packet) {
        try {
            const {numberOfFiles, totalPayloadSize, open} = packet.body;
            const inBatch = Number.isInteger(numberOfFiles) && !open;
            let batch = inBatch ? this._receiveBatch : null;

            if (batch !== null && batch.transfer === null &&
                GLib.get_monotonic_time() - batch.lastActivity > BATCH_IDLE_TIMEOUT) {
                this._receiveBatch = null;
                this._showReceiveResult(batch, true);
                batch = null;
            }

            if (batch === null) {
                batch = this._createBatch(
                    inBatch ? numberOfFiles : 1,
                    inBatch ? (totalPayloadSize ?? 0) : packet.payloadSize
                );

                if (inBatch)
                    this._receiveBatch = batch;
            } else {
                batch.numberOfFiles = Math.max(batch.numberOfFiles, numberOfFiles);
                batch.totalPayloadSize = Math.max(batch.totalPayloadSize,
                    totalPayloadSize ?? 0);
            }

            const file = this._getFile(packet.body.filename);
            const transfer = this.device.createTransfer();
            transfer.addFile(packet, file);

            batch.filename = packet.body.filename;
            batch.transfer = transfer;
            this._showReceiveProgress(batch);

            let failed = false;

            try {
                await transfer.start();

                batch.files.push(file);
                batch.transferredSize += packet.payloadSize;

                const gtk_recent_manager = Gtk.RecentManager.get_default();
                gtk_recent_manager.add_item(file.get_uri());

                if (open) {
                    const uri = file.get_uri();
                    Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
                }
            } catch (e) {
                debug(e, this.device.name);
                failed = true;

                // Clean up the downloaded file on failure
                file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
            }

            batch.transfer = null;
            batch.lastActivity = GLib.get_monotonic_time();

            if (!failed && batch.files.length < batch.numberOfFiles) {
                this._showReceiveProgress(batch);
                return;
            }

            if (this._receiveBatch === batch)
                this._receiveBatch = null;

            this._showReceiveResult(batch, failed);
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    _showReceiveResult(batch, failed) {
        const params = {};

        if (!failed) {
            const uri = batch.files.at(-1).get_uri();

            params.title = _('Transfer Successful');
            params.icon = new Gio.ThemedIcon({name: 'document-save-symbolic'});
            params.action = {
                name: 'showPathInFolder',
                parameter: new GLib.Variant('s', uri),
            };
            params.buttons = [{
                label: _('Show File Location'),
                action: 'showPathInFolder',
                parameter: new GLib.Variant('s', uri),
            }];

            if (batch.numberOfFiles === 1) {
                // TRANSLATORS: eg. Received 'book.pdf' from Google Pixel
                params.body = _('Received “%s” from %s').format(
                    batch.filename,
                    this.device.name
                );
                params.buttons.push({
                    label: _('Open File'),
                    action: 'openPath',
                    parameter: new GLib.Variant('s', uri),
                });
            } else {
                params.body = ngettext(
                    // TRANSLATORS: eg. Received 12 files from Google Pixel
                    'Received %d file from %s',
                    'Received %d files from %s',
                    batch.files.length
                ).format(batch.files.length, this.device.name);
            }
        } else {
            params.title = _('Transfer Failed');
            params.icon = new Gio.ThemedIcon({name: 'dialog-warning-symbolic'});

            if (batch.numberOfFiles === 1) {
                // TRANSLATORS: eg. Failed to receive 'book.pdf' from Google Pixel
                params.body = _('Failed to receive “%s” from %s').format(
                    batch.filename,
                    this.device.name
                );
            } else {
                // TRANSLATORS: eg. Received 5 of 12 files from Google Pixel
                params.body = _('Received %d of %d files from %s').format(
                    batch.files.length,
                    batch.numberOfFiles,
                    this.device.name
                );
            }
        }

        this._showBatchResult(batch, params);
    }

    _handleUri(uri) {
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    }

    _handleText(message) {
        const dialog = new Gtk.MessageDialog({
            text: _('Text Shared By %s').format(this.device.name),
            secondary_text: URI.linkify(message),
            secondary_use_markup: true,
            buttons: Gtk.ButtonsType.CLOSE,
        });
        dialog.message_area.get_children()[1].selectable = true;
        dialog.set_keep_above(true);
        dialog.connect('response', (dialog) => dialog.destroy());
        dialog.show();
    }

    /**
     * Open the file chooser dialog for selecting a file or inputing a URI.
     */
    share() {
        const dialog = new FileChooserDialog(this.device);
        dialog.show();
    }

    /**
     * Share local file path or URI. Files shared in quick succession are sent
     * together, so the device can report the progress of all of them.
     *
     * @param {string} path - Local file path or URI
     * @param {boolean} open - Whether the file should be opened after transfer
     */
    async shareFile(path, open = false) {
        // Files being looked up count as shared together with the others
        this._pendingShares++;

        try {
            let file = null;

            if (path.includes('://'))
                file = Gio.File.new_for_uri(path);
            else
                file = Gio.File.new_for_path(path);

            const info = await file.query_info_async(
                Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null);
            const size = info.get_size();

            // Files to open are sent on their own, as KDE Connect does
            if (open) {
                const batch = this._createBatch(1, size);
                batch.open = true;
                batch.queue = [{file, size}];
                this._sendFiles(batch);
                return;
            }

            let batch = this._sendBatch;

            if (batch === null) {
                batch = this._createBatch(0, 0);
                batch.queue = [];
                this._sendBatch = batch;
            }

            batch.queue.push({file, size});
            batch.numberOfFiles++;
            batch.totalPayloadSize += size;

            // Tell the device about files added while the batch is running
            if (batch.running && !batch.updatePending) {
                batch.updatePending = true;

                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    batch.updatePending = false;
                    this.device.sendPacket({
                        type: 'kdeconnect.share.request.update',
                        body: {
                            numberOfFiles: batch.numberOfFiles,
                            totalPayloadSize: batch.totalPayloadSize,
                        },
                    });
                    return GLib.SOURCE_REMOVE;
                });
            }
        } catch (e) {
            debug(e, this.device.name);
        } finally {
            this._pendingShares--;

            // Send once every file shared at the same time has joined
            if (this._pendingShares === 0)
                this._startSendBatch();
        }
    }

    /**
     * Start sending the batch of files waiting to be sent, unless it is
     * already running or about to.
     */
    _startSendBatch() {
        const batch = this._sendBatch;

        if (batch === null || batch.running || batch.scheduled)
            return;

        batch.scheduled = true;

        // Let files shared by the same request that are not looked up yet join
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._sendFiles(batch);
            return GLib.SOURCE_REMOVE;
        });
    }

    _showSendProgress(batch, file) {
        let body;

        if (batch.numberOfFiles === 1) {
            // TRANSLATORS: eg. Sending 'book.pdf' to Google Pixel
            body = _('Sending “%s” to %s').format(
                file.get_basename(),
                this.device.name
            );
        } else {
            // TRANSLATORS: eg. Sending file 3 of 12 to Google Pixel (25%)
            body = _('Sending file %d of %d to %s (%d%%)').format(
                batch.files.length + 1,
                batch.numberOfFiles,
                this.device.name,
                this._getBatchProgress(batch)
            );
        }

        this._showBatchProgress(batch, _('Transferring File'), body,
            'document-send-symbolic');
    }

    /**
     * Send the files of a batch one after another.
     *
     * @param {object} batch - The batch
     */
    async _sendFiles(batch) {
        let failed = false;
        let item;

        batch.running = true;

        try {
            while ((item = batch.queue.shift())) {
                const body = {filename: item.file.get_basename()};

                if (batch.open) {
                    body.open = true;
                } else {
                    body.numberOfFiles = batch.numberOfFiles;
                    body.totalPayloadSize = batch.totalPayloadSize;
                }

                batch.transfer = this.device.createTransfer();
                batch.transfer.addFile({
                    type: 'kdeconnect.share.request',
                    body: body,
                }, item.file);
                batch.filename = item.file.get_basename();
                this._showSendProgress(batch, item.file);

                await batch.transfer.start();

                batch.files.push(item.file);
                batch.transferredSize += item.size;
            }
        } catch (e) {
            debug(e, this.device.name);
            failed = true;
        } finally {
            batch.transfer = null;
            batch.running = false;

            if (this._sendBatch === batch)
                this._sendBatch = null;
        }

        const params = {};

        if (!failed) {
            params.title = _('Transfer Successful');
            params.icon = new Gio.ThemedIcon({name: 'document-send-symbolic'});

            if (batch.numberOfFiles === 1) {
                // TRANSLATORS: eg. Sent "book.pdf" to Google Pixel
                params.body = _('Sent “%s” to %s').format(
                    batch.filename,
                    this.device.name
                );
            } else {
                params.body = ngettext(
                    // TRANSLATORS: eg. Sent 12 files to Google Pixel
                    'Sent %d file to %s',
                    'Sent %d files to %s',
                    batch.files.length
                ).format(batch.files.length, this.device.name);
            }
        } else {
            params.title = _('Transfer Failed');
            params.icon = new Gio.ThemedIcon({name: 'dialog-warning-symbolic'});

            if (batch.numberOfFiles === 1) {
                // TRANSLATORS: eg. Failed to send "book.pdf" to Google Pixel
                params.body = _('Failed to send “%s” to %s').format(
                    batch.filename,
                    this.device.name
                );
            } else {
                // TRANSLATORS: eg. Sent 5 of 12 files to Google Pixel
                params.body = _('Sent %d of %d files to %s').format(
                    batch.files.length,
                    batch.numberOfFiles,
                    this.device.name
                );
            }
        }

        this._showBatchResult(batch, params);
    }

    /**
     * Share a string of text. Remote behaviour is undefined.
     *
     * @param {string} text - A string of unicode text
     */
    shareText(text) {
        this.device.sendPacket({
            type: 'kdeconnect.share.request',
            body: {text: text},
        });
    }

    /**
     * Share a URI. Generally the remote device opens it with the scheme default
     *
     * @param {string} uri - A URI to share
     */
    shareUri(uri) {
        if (GLib.uri_parse_scheme(uri) === 'file') {
            this.shareFile(uri);
            return;
        }

        this.device.sendPacket({
            type: 'kdeconnect.share.request',
            body: {url: uri},
        });
    }
});


/** A simple FileChooserDialog for sharing files */
const FileChooserDialog = GObject.registerClass({
    GTypeName: 'GSConnectShareFileChooserDialog',
}, class FileChooserDialog extends Gtk.FileChooserDialog {

    _init(device) {
        super._init({
            // TRANSLATORS: eg. Send files to Google Pixel
            title: _('Send files to %s').format(device.name),
            select_multiple: true,
            extra_widget: new Gtk.CheckButton({
                // TRANSLATORS: Mark the file to be opened once completed
                label: _('Open when done'),
                visible: true,
            }),
            use_preview_label: false,
        });

        this.device = device;

        // Align checkbox with sidebar
        const box = this.get_content_area().get_children()[0].get_children()[0];
        const paned = box.get_children()[0];
        paned.bind_property(
            'position',
            this.extra_widget,
            'margin-left',
            GObject.BindingFlags.SYNC_CREATE
        );

        // Preview Widget
        this.preview_widget = new Gtk.Image();
        this.preview_widget_active = false;
        this.connect('update-preview', this._onUpdatePreview);

        // URI entry
        this._uriEntry = new Gtk.Entry({
            placeholder_text: 'https://',
            hexpand: true,
            visible: true,
        });
        this._uriEntry.connect('activate', this._sendLink.bind(this));

        // URI/File toggle
        this._uriButton = new Gtk.ToggleButton({
            image: new Gtk.Image({
                icon_name: 'web-browser-symbolic',
                pixel_size: 16,
            }),
            valign: Gtk.Align.CENTER,
            // TRANSLATORS: eg. Send a link to Google Pixel
            tooltip_text: _('Send a link to %s').format(device.name),
            visible: true,
        });
        this._uriButton.connect('toggled', this._onUriButtonToggled.bind(this));

        this.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        const sendButton = this.add_button(_('Send'), Gtk.ResponseType.OK);
        sendButton.connect('clicked', this._sendLink.bind(this));

        this.get_header_bar().pack_end(this._uriButton);
        this.set_default_response(Gtk.ResponseType.OK);
    }

    _onUpdatePreview(chooser) {
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(
                chooser.get_preview_filename(),
                chooser.get_scale_factor() * 128,
                -1
            );
            chooser.preview_widget.pixbuf = pixbuf;
            chooser.preview_widget.visible = true;
            chooser.preview_widget_active = true;
        } catch {
            chooser.preview_widget.visible = false;
            chooser.preview_widget_active = false;
        }
    }

    _onUriButtonToggled(button) {
        const header = this.get_header_bar();

        // Show and focus the URL entry
        if (button.active) {
            this.extra_widget.sensitive = false;
            header.set_custom_title(this._uriEntry);
            this._uriEntry.grab_focus();
            this.set_response_sensitive(Gtk.ResponseType.OK, true);

        // Hide the URL entry
        } else {
            header.set_custom_title(null);
            this.set_response_sensitive(
                Gtk.ResponseType.OK,
                this.get_uris().length > 1
            );
            this.extra_widget.sensitive = true;
        }
    }

    _sendLink(widget) {
        if (this._uriButton.active && this._uriEntry.text.length)
            this.response(1);
    }

    vfunc_response(response_id) {
        if (response_id === Gtk.ResponseType.OK) {
            for (const uri of this.get_uris()) {
                const parameter = new GLib.Variant(
                    '(sb)',
                    [uri, this.extra_widget.active]
                );
                this.device.activate_action('shareFile', parameter);
            }
        } else if (response_id === 1) {
            const parameter = new GLib.Variant('s', this._uriEntry.text);
            this.device.activate_action('shareUri', parameter);
        }

        this.destroy();
    }
});

export default SharePlugin;
