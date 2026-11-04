// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Core from '../core.js';
import Plugin from '../plugin.js';


export const Metadata = {
    label: _('SFTP'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SFTP',
    description: _('Browse the paired device filesystem'),
    incomingCapabilities: ['kdeconnect.sftp'],
    outgoingCapabilities: ['kdeconnect.sftp.request'],
    actions: {
        mount: {
            label: _('Mount'),
            icon_name: 'folder-remote-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.sftp'],
            outgoing: ['kdeconnect.sftp.request'],
        },
        unmount: {
            label: _('Unmount'),
            icon_name: 'media-eject-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.sftp'],
            outgoing: ['kdeconnect.sftp.request'],
        },
    },
};


const MAX_MOUNT_DIRS = 12;


/**
 * SFTP Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sftp
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SftpPlugin
 */
const SFTPPlugin = GObject.registerClass({
    GTypeName: 'GSConnectSFTPPlugin',
}, class SFTPPlugin extends Plugin {

    _init(device) {
        super._init(device, 'sftp');

        this._gmount = null;
        this._mounting = false;

        // A reusable launcher for ssh processes
        this._launcher = new Gio.SubprocessLauncher({
            flags: (Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_MERGE),
        });

        // Watch the volume monitor
        this._volumeMonitor = Gio.VolumeMonitor.get();

        this._mountAddedId = this._volumeMonitor.connect(
            'mount-added',
            this._onMountAdded.bind(this)
        );

        this._mountRemovedId = this._volumeMonitor.connect(
            'mount-removed',
            this._onMountRemoved.bind(this)
        );

        // Bookmark the mounted files in the Files sidebar, from the "Files"
        // submenu. It's not a plugin action, so it has no keyboard shortcut.
        this._bookmarkAction = new Gio.SimpleAction({name: 'toggleBookmark'});
        this._bookmarkAction.connect('activate', this.toggleBookmark.bind(this));
        this.device.add_action(this._bookmarkAction);

        // The device can be renamed, in KDE Connect on the device
        this._linkName = this.device.name;
        this._nameChangedId = this.device.connect('notify::name',
            this._onNameChanged.bind(this));
    }

    get gmount() {
        if (this._gmount === null && this.device.connected) {
            const host = this.device.channel.host;

            const regex = new RegExp(
                `sftp://(${host}):(1739|17[4-5][0-9]|176[0-4])`
            );

            for (const mount of this._volumeMonitor.get_mounts()) {
                const uri = mount.get_root().get_uri();

                if (regex.test(uri)) {
                    this._gmount = mount;
                    this._addSubmenu(mount);
                    this._addSymlink(mount);

                    break;
                }
            }
        }

        return this._gmount;
    }

    connected() {
        super.connected();

        // Only enable for Lan connections
        if (this.device.channel.constructor.name === 'LanChannel') { // FIXME: Circular import workaround
            if (this.settings.get_boolean('automount'))
                this.mount();
        } else {
            this.device.lookup_action('mount').enabled = false;
            this.device.lookup_action('unmount').enabled = false;
        }
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.sftp':
                if (packet.body.hasOwnProperty('errorMessage'))
                    this._handleError(packet);
                else
                    this._handleMount(packet);

                break;
        }
    }

    _onMountAdded(monitor, mount) {
        if (this._gmount !== null || !this.device.connected)
            return;

        const host = this.device.channel.host;
        const regex = new RegExp(`sftp://(${host}):(1739|17[4-5][0-9]|176[0-4])`);
        const uri = mount.get_root().get_uri();

        if (!regex.test(uri))
            return;

        this._gmount = mount;
        this._addSubmenu(mount);
        this._addSymlink(mount);
    }

    _onMountRemoved(monitor, mount) {
        if (this.gmount !== mount)
            return;

        this._gmount = null;
        this._removeSubmenu();
    }

    async _listDirectories(mount) {
        const file = mount.get_root();

        const iter = await file.enumerate_children_async(
            Gio.FILE_ATTRIBUTE_STANDARD_NAME,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            this.cancellable);

        const infos = await iter.next_files_async(MAX_MOUNT_DIRS,
            GLib.PRIORITY_DEFAULT, this.cancellable);
        iter.close_async(GLib.PRIORITY_DEFAULT, null, null);

        const directories = {};

        for (const info of infos) {
            const name = info.get_name();
            directories[name] = `${file.get_uri()}${name}/`;
        }

        return directories;
    }

    _onAskQuestion(op, message, choices) {
        op.reply(Gio.MountOperationResult.HANDLED);
    }

    _onAskPassword(op, message, user, domain, flags) {
        op.reply(Gio.MountOperationResult.HANDLED);
    }

    /**
     * Handle an error reported by the remote device.
     *
     * @param {Core.Packet} packet - a `kdeconnect.sftp`
     */
    _handleError(packet) {
        this.device.showNotification({
            id: 'sftp-error',
            title: _('%s reported an error').format(this.device.name),
            body: packet.body.errorMessage,
            icon: new Gio.ThemedIcon({name: 'dialog-error-symbolic'}),
            priority: Gio.NotificationPriority.HIGH,
        });
    }

    /**
     * Mount the remote device using the provided information.
     *
     * @param {Core.Packet} packet - a `kdeconnect.sftp`
     */
    async _handleMount(packet) {
        try {
            // Already mounted or mounting
            if (this.gmount !== null || this._mounting)
                return;

            this._mounting = true;

            // Ensure the private key is in the keyring
            await this._addPrivateKey();

            // Create a new mount operation
            const op = new Gio.MountOperation({
                username: packet.body.user || null,
                password: packet.body.password || null,
                password_save: Gio.PasswordSave.NEVER,
            });

            op.connect('ask-question', this._onAskQuestion);
            op.connect('ask-password', this._onAskPassword);

            // This is the actual call to mount the device
            const host = this.device.channel.host;
            const uri = `sftp://${host}:${packet.body.port}/`;
            const file = Gio.File.new_for_uri(uri);

            await file.mount_enclosing_volume(GLib.PRIORITY_DEFAULT, op,
                this.cancellable);
        } catch (e) {
            // Special case when the GMount didn't unmount properly but is still
            // on the same port and can be reused.
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.ALREADY_MOUNTED))
                return;

            // There's a good chance this is a host key verification error;
            // regardless we'll remove the key for security.
            this._removeHostKey(this.device.channel.host);
            logError(e, this.device.name);
        } finally {
            this._mounting = false;
        }
    }

    /**
     * Add GSConnect's private key identity to the authentication agent so our
     * identity can be verified by Android during private key authentication.
     *
     * @returns {Promise} A promise for the operation
     */
    async _addPrivateKey() {
        const ssh_add = this._launcher.spawnv([
            Config.SSHADD_PATH,
            GLib.build_filenamev([Config.CONFIGDIR, 'private.pem']),
        ]);

        const [stdout] = await ssh_add.communicate_utf8_async(null,
            this.cancellable);

        if (ssh_add.get_exit_status() !== 0)
            debug(stdout.trim(), this.device.name);
    }

    /**
     * Remove all host keys from ~/.ssh/known_hosts for {@link host} in the
     * port range used by KDE Connect (1739-1764).
     *
     * @param {string} host - A hostname or IP address
     */
    async _removeHostKey(host) {
        for (let port = 1739; port <= 1764; port++) {
            try {
                const ssh_keygen = this._launcher.spawnv([
                    Config.SSHKEYGEN_PATH,
                    '-R',
                    `[${host}]:${port}`,
                ]);

                const [stdout] = await ssh_keygen.communicate_utf8_async(null,
                    this.cancellable);

                const status = ssh_keygen.get_exit_status();

                if (status !== 0) {
                    throw new Gio.IOErrorEnum({
                        code: Gio.io_error_from_errno(status),
                        message: `${GLib.strerror(status)}\n${stdout}`.trim(),
                    });
                }
            } catch (e) {
                logError(e, this.device.name);
            }
        }
    }

    /*
     * Mount menu helpers
     */
    _getUnmountSection() {
        if (this._unmountSection === undefined) {
            this._unmountSection = new Gio.Menu();

            const unmountItem = new Gio.MenuItem();
            unmountItem.set_label(Metadata.actions.unmount.label);
            unmountItem.set_icon(new Gio.ThemedIcon({
                name: Metadata.actions.unmount.icon_name,
            }));
            unmountItem.set_detailed_action('device.unmount');
            this._unmountSection.append_item(unmountItem);
        }

        return this._unmountSection;
    }

    _getFilesMenuItem() {
        if (this._filesMenuItem === undefined) {
            // Files menu icon
            const emblem = new Gio.Emblem({
                icon: new Gio.ThemedIcon({name: 'emblem-default'}),
            });

            const mountedIcon = new Gio.EmblemedIcon({
                gicon: new Gio.ThemedIcon({name: 'folder-remote-symbolic'}),
            });
            mountedIcon.add_emblem(emblem);

            // Files menu item
            this._filesMenuItem = new Gio.MenuItem();
            this._filesMenuItem.set_detailed_action('device.mount');
            this._filesMenuItem.set_icon(mountedIcon);
            this._filesMenuItem.set_label(_('Files'));
        }

        return this._filesMenuItem;
    }

    async _addSubmenu(mount) {
        try {
            const directories = await this._listDirectories(mount);

            // Submenu sections
            const dirSection = new Gio.Menu();
            const unmountSection = this._getUnmountSection();

            for (const [name, uri] of Object.entries(directories))
                dirSection.append(name, `device.openPath::${uri}`);

            // Files submenu
            const filesSubmenu = new Gio.Menu();
            filesSubmenu.append_section(null, dirSection);
            filesSubmenu.append_section(null, this._getBookmarkSection());
            filesSubmenu.append_section(null, unmountSection);
            this._watchBookmarks();

            // Files menu item
            const filesMenuItem = this._getFilesMenuItem();
            filesMenuItem.set_submenu(filesSubmenu);

            // Replace the existing menu item
            const index = this.device.removeMenuAction('device.mount');
            this.device.addMenuItem(filesMenuItem, index);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);

            // Reset to allow retrying
            this._gmount = null;
        }
    }

    _removeSubmenu() {
        this._unwatchBookmarks();

        try {
            const index = this.device.removeMenuAction('device.mount');
            const action = this.device.lookup_action('mount');

            if (action !== null) {
                this.device.addMenuAction(
                    action,
                    index,
                    Metadata.actions.mount.label,
                    Metadata.actions.mount.icon_name
                );
            }
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    /*
     * Files bookmark helpers
     */
    get bookmarksFile() {
        // GTK 3 and 4 file choosers and Files all use this file
        if (this._bookmarksFile === undefined) {
            this._bookmarksFile = Gio.File.new_for_path(GLib.build_filenamev([
                GLib.get_user_config_dir(),
                'gtk-3.0',
                'bookmarks',
            ]));
        }

        return this._bookmarksFile;
    }

    set bookmarksFile(file) {
        this._bookmarksFile = file;
    }

    /**
     * Get the path of the symbolic link referring to the device by name,
     * which stays the same when its IP address changes.
     *
     * @param {string} [name] - A device name, the current one by default
     * @returns {string} An absolute path
     */
    _getSymlinkPath(name = this.device.name) {
        // Replace path separator with a Unicode lookalike:
        let safe_device_name = name.replace('/', '∕');

        if (safe_device_name === '.')
            safe_device_name = '·';
        else if (safe_device_name === '..')
            safe_device_name = '··';

        return `${Config.RUNTIMEDIR}/by-name/${safe_device_name}`;
    }

    _getBookmarkUri(name = this.device.name) {
        return Gio.File.new_for_path(this._getSymlinkPath(name)).get_uri();
    }

    /**
     * Read the bookmarks file as a list of lines, each a URI followed by an
     * optional label.
     *
     * @returns {string[]} The lines, without empty ones
     */
    _readBookmarks() {
        try {
            const [, contents] = this.bookmarksFile.load_contents(null);

            return new TextDecoder().decode(contents)
                .split('\n')
                .filter(line => line.trim() !== '');
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                debug(e, this.device.name);

            return [];
        }
    }

    _isBookmark(line, uri) {
        return line.split(' ', 1)[0] === uri;
    }

    /**
     * Whether the device's files are bookmarked in the Files sidebar.
     *
     * @returns {boolean} %true if bookmarked
     */
    isBookmarked() {
        const uri = this._getBookmarkUri();

        return this._readBookmarks().some(line => this._isBookmark(line, uri));
    }

    /**
     * Add the device's files to the Files sidebar, or remove them from it.
     * The bookmark refers to the device by name, so it keeps working when the
     * device's IP address changes, and shows as unavailable while unmounted.
     */
    toggleBookmark() {
        try {
            const uri = this._getBookmarkUri();
            let lines = this._readBookmarks();

            if (lines.some(line => this._isBookmark(line, uri)))
                lines = lines.filter(line => !this._isBookmark(line, uri));
            else
                lines.push(`${uri} ${this.device.name}`);

            this._writeBookmarks(lines);
        } catch (e) {
            logError(e, this.device.name);
        }

        this._updateBookmarkSection();
    }

    _writeBookmarks(lines) {
        try {
            this.bookmarksFile.get_parent().make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }

        const contents = lines.length ? `${lines.join('\n')}\n` : '';
        this.bookmarksFile.replace_contents(
            new TextEncoder().encode(contents),
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null);
    }

    /**
     * Move the link and the bookmark to the device's new name, keeping a
     * label the user gave the bookmark.
     */
    _onNameChanged() {
        const oldName = this._linkName;
        const newName = this.device.name;

        if (oldName === newName)
            return;

        this._linkName = newName;

        try {
            const oldUri = this._getBookmarkUri(oldName);
            const newUri = this._getBookmarkUri(newName);
            let changed = false;

            const lines = this._readBookmarks().map(line => {
                if (!this._isBookmark(line, oldUri))
                    return line;

                changed = true;
                const label = line.slice(oldUri.length + 1);

                if (label === '')
                    return newUri;

                return `${newUri} ${label === oldName ? newName : label}`;
            });

            if (changed)
                this._writeBookmarks(lines);
        } catch (e) {
            logError(e, this.device.name);
        }

        // Replace the old link, which isn't updated anymore
        try {
            Gio.File.new_for_path(this._getSymlinkPath(oldName)).delete(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                debug(e, this.device.name);
        }

        if (this._gmount !== null)
            this._addSymlink(this._gmount);

        this._updateBookmarkSection();
    }

    _getBookmarkSection() {
        if (this._bookmarkSection === undefined)
            this._bookmarkSection = new Gio.Menu();

        this._updateBookmarkSection();

        return this._bookmarkSection;
    }

    _updateBookmarkSection() {
        if (this._bookmarkSection === undefined)
            return;

        // The same labels as in Files
        const label = this.isBookmarked()
            ? _('Remove from Bookmarks')
            : _('Add to Bookmarks');

        if (this._bookmarkSection.get_n_items() === 1 &&
            this._bookmarkLabel === label)
            return;

        this._bookmarkLabel = label;
        this._bookmarkSection.remove_all();
        this._bookmarkSection.append(label, 'device.toggleBookmark');
    }

    /**
     * Keep the bookmark item up to date while the files are mounted, since
     * the bookmark can also be removed or added in Files.
     */
    _watchBookmarks() {
        if (this._bookmarksMonitor !== undefined)
            return;

        try {
            this._bookmarksMonitor = this.bookmarksFile.monitor_file(
                Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._bookmarksMonitor.connect('changed',
                () => this._updateBookmarkSection());
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    _unwatchBookmarks() {
        if (this._bookmarksMonitor === undefined)
            return;

        this._bookmarksMonitor.cancel();
        this._bookmarksMonitor = undefined;
    }

    /**
     * Create a symbolic link referring to the device by name
     *
     * @param {Gio.Mount} mount - A GMount to link to
     */
    async _addSymlink(mount) {
        try {
            const by_name_dir = Gio.File.new_for_path(
                `${Config.RUNTIMEDIR}/by-name/`
            );

            try {
                by_name_dir.make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw e;
            }

            const link_target = mount.get_root().get_path();
            const link = Gio.File.new_for_path(this._getSymlinkPath());

            // Check for and remove any existing stale link
            try {
                const link_stat = await link.query_info_async(
                    'standard::symlink-target',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    GLib.PRIORITY_DEFAULT,
                    this.cancellable);

                if (link_stat.get_symlink_target() === link_target)
                    return;

                await link.delete_async(GLib.PRIORITY_DEFAULT,
                    this.cancellable);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    throw e;
            }

            link.make_symbolic_link(link_target, this.cancellable);
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    /**
     * Send a request to mount the remote device
     */
    mount() {
        if (this.gmount !== null)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.sftp.request',
            body: {
                startBrowsing: true,
            },
        });
    }

    /**
     * Remove the menu items, unmount the filesystem, replace the mount item
     */
    async unmount() {
        try {
            if (this.gmount === null)
                return;

            this._removeSubmenu();
            this._mounting = false;

            await this.gmount.unmount_with_operation(
                Gio.MountUnmountFlags.FORCE,
                new Gio.MountOperation(),
                this.cancellable);
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    destroy() {
        this._unwatchBookmarks();
        this.device.remove_action('toggleBookmark');
        this.device.disconnect(this._nameChangedId);

        if (this._volumeMonitor) {
            this._volumeMonitor.disconnect(this._mountAddedId);
            this._volumeMonitor.disconnect(this._mountRemovedId);
            this._volumeMonitor = null;
        }

        super.destroy();
    }
});

export default SFTPPlugin;
