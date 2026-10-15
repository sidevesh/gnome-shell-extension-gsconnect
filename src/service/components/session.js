// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';


/**
 * The user's login session, as tracked by systemd-logind.
 */
const Session = GObject.registerClass({
    GTypeName: 'GSConnectSession',
    Signals: {
        'changed': {
            flags: GObject.SignalFlags.RUN_FIRST,
        },
    },
}, class Session extends GObject.Object {

    _init() {
        super._init();

        this._connection = Gio.DBus.system;
        this._session = null;

        this._initAsync();
    }

    /**
     * Get the object path of the user's graphical session, falling back to
     * their first session.
     *
     * @returns {Promise<string>} A logind session object path
     */
    async _getSessionPath() {
        try {
            const reply = await this._connection.call(
                'org.freedesktop.login1',
                '/org/freedesktop/login1/user/self',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.freedesktop.login1.User', 'Display']),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null);

            // eslint-disable-next-line no-unused-vars
            const [id, objectPath] = reply.deepUnpack()[0].deepUnpack();

            if (objectPath !== '/')
                return objectPath;
        } catch (e) {
            debug(e);
        }

        const reply = await this._connection.call(
            'org.freedesktop.login1',
            '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager',
            'ListSessions',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null);

        const sessions = reply.deepUnpack()[0];
        const userName = GLib.get_user_name();

        // eslint-disable-next-line no-unused-vars
        for (const [num, uid, name, seat, objectPath] of sessions) {
            if (name === userName)
                return objectPath;
        }

        return '/org/freedesktop/login1/session/auto';
    }

    async _initAsync() {
        try {
            const sessionPath = await this._getSessionPath();

            this._session = new Gio.DBusProxy({
                g_connection: this._connection,
                g_name: 'org.freedesktop.login1',
                g_object_path: sessionPath,
                g_interface_name: 'org.freedesktop.login1.Session',
            });
            await this._session.init_async(GLib.PRIORITY_DEFAULT, null);

            this._propertiesChangedId = this._session.connect(
                'g-properties-changed',
                () => this.emit('changed')
            );
        } catch (e) {
            this._session = null;
            logError(e);
        }
    }

    get idle() {
        if (this._session === null)
            return false;

        return this._session.get_cached_property('IdleHint').unpack();
    }

    get locked() {
        if (this._session === null)
            return false;

        return this._session.get_cached_property('LockedHint').unpack();
    }

    get active() {
        // Active if not idle and not locked
        return !(this.idle || this.locked);
    }

    async _callSession(method) {
        if (this._session === null) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.NOT_INITIALIZED,
                message: 'No login session',
            });
        }

        await this._session.call(method, null, Gio.DBusCallFlags.NONE, -1,
            null);
    }

    /**
     * Ask logind to lock the session.
     */
    async lock() {
        await this._callSession('Lock');
    }

    /**
     * Ask logind to unlock the session. The desktop's screen locker unlocks
     * without asking for the password.
     */
    async unlock() {
        await this._callSession('Unlock');
    }

    destroy() {
        if (this._propertiesChangedId) {
            this._session.disconnect(this._propertiesChangedId);
            this._propertiesChangedId = 0;
        }

        this._session = null;
    }
});


/**
 * The service class for this component
 */
export default Session;
