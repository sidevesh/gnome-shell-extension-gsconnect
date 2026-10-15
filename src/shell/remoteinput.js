// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import Config from '../config.js';

import {HAS_ST_ORIENTATION} from './utils.js';


/*
 * The interval (in ms) at which captured events are flushed to the device.
 */
const FLUSH_INTERVAL = 16;

/**
 * A map of Clutter to "KDE Connect" keyvals
 */
const ReverseKeyMap = new Map([
    [Clutter.KEY_BackSpace, 1],
    [Clutter.KEY_Tab, 2],
    [Clutter.KEY_Linefeed, 3],
    [Clutter.KEY_Left, 4],
    [Clutter.KEY_Up, 5],
    [Clutter.KEY_Right, 6],
    [Clutter.KEY_Down, 7],
    [Clutter.KEY_Page_Up, 8],
    [Clutter.KEY_Page_Down, 9],
    [Clutter.KEY_Home, 10],
    [Clutter.KEY_End, 11],
    [Clutter.KEY_Return, 12],
    [Clutter.KEY_Delete, 13],
    [Clutter.KEY_Escape, 14],
    [Clutter.KEY_Sys_Req, 15],
    [Clutter.KEY_Scroll_Lock, 16],
    [Clutter.KEY_F1, 21],
    [Clutter.KEY_F2, 22],
    [Clutter.KEY_F3, 23],
    [Clutter.KEY_F4, 24],
    [Clutter.KEY_F5, 25],
    [Clutter.KEY_F6, 26],
    [Clutter.KEY_F7, 27],
    [Clutter.KEY_F8, 28],
    [Clutter.KEY_F9, 29],
    [Clutter.KEY_F10, 30],
    [Clutter.KEY_F11, 31],
    [Clutter.KEY_F12, 32],
]);

/*
 * A list of keyvals we consider modifiers
 */
const MOD_KEYS = [
    Clutter.KEY_Alt_L,
    Clutter.KEY_Alt_R,
    Clutter.KEY_Caps_Lock,
    Clutter.KEY_Control_L,
    Clutter.KEY_Control_R,
    Clutter.KEY_Meta_L,
    Clutter.KEY_Meta_R,
    Clutter.KEY_Num_Lock,
    Clutter.KEY_Shift_L,
    Clutter.KEY_Shift_R,
    Clutter.KEY_Super_L,
    Clutter.KEY_Super_R,
];

const DEFAULT_MOD_MASK = Clutter.ModifierType.SHIFT_MASK |
                         Clutter.ModifierType.CONTROL_MASK |
                         Clutter.ModifierType.MOD1_MASK |
                         Clutter.ModifierType.SUPER_MASK;


/**
 * Parse an accelerator in the form returned by Gtk.accelerator_name() into a
 * keyval and modifier mask that can be matched against Clutter key events.
 *
 * @param {string} accelerator - An accelerator (eg. '<Control><Alt>Escape')
 * @returns {number[]} A [keyval, modifiers] pair, [0, 0] on failure
 */
function _parseAccelerator(accelerator) {
    let mods = 0;

    for (const [, mod] of accelerator.matchAll(/<([^>]+)>/g)) {
        switch (mod.toLowerCase()) {
            case 'control':
            case 'ctrl':
            case 'ctl':
            case 'primary':
                mods |= Clutter.ModifierType.CONTROL_MASK;
                break;

            case 'shift':
                mods |= Clutter.ModifierType.SHIFT_MASK;
                break;

            case 'alt':
            case 'mod1':
                mods |= Clutter.ModifierType.MOD1_MASK;
                break;

            case 'super':
                mods |= Clutter.ModifierType.SUPER_MASK;
                break;
        }
    }

    const key = accelerator.replace(/<[^>]*>/g, '');
    let keyval = 0;

    if (key.length === 1) {
        const codePoint = key.toLowerCase().codePointAt(0);
        keyval = codePoint < 0x80
            ? codePoint
            : Clutter.unicode_to_keysym?.(codePoint) ?? 0;
    } else if (typeof Clutter[`KEY_${key}`] === 'number') {
        keyval = Clutter[`KEY_${key}`];
    }

    return [keyval, mods];
}


/**
 * Get a human readable label for an accelerator.
 *
 * @param {string} accelerator - An accelerator (eg. '<Control><Alt>Escape')
 * @returns {string} A label (eg. 'Ctrl+Alt+Escape')
 */
function _acceleratorLabel(accelerator) {
    const parts = [];

    for (const [, mod] of accelerator.matchAll(/<([^>]+)>/g)) {
        switch (mod.toLowerCase()) {
            case 'control':
            case 'ctrl':
            case 'ctl':
            case 'primary':
                parts.push('Ctrl');
                break;

            case 'alt':
            case 'mod1':
                parts.push('Alt');
                break;

            default:
                parts.push(mod.charAt(0).toUpperCase() + mod.slice(1));
        }
    }

    parts.push(accelerator.replace(/<[^>]*>/g, ''));

    return parts.join('+');
}


/**
 * An input sharing session, capturing all pointer and keyboard input with a
 * modal grab and forwarding it to a device, while displaying a persistent
 * dialog with the keyboard shortcut that ends the session.
 */
class InputSession {

    /**
     * @param {object} params - A dictionary of parameters
     * @param {Gio.DBusProxy} params.device - The device to forward input to
     * @param {string} params.accelerator - The accelerator that stops sharing
     * @param {object} params.monitor - The monitor the session started on
     * @param {() => void} params.onStop - A callback for when the session ends
     */
    constructor(params) {
        this._device = params.device;
        this._monitor = params.monitor;
        this._onStop = params.onStop;

        [this._stopKeyval, this._stopMods] = _parseAccelerator(
            params.accelerator);

        // Fallback, to guarantee the session can always be ended
        if (this._stopKeyval === 0) {
            this._stopKeyval = Clutter.KEY_Escape;
            this._stopMods = Clutter.ModifierType.CONTROL_MASK |
                Clutter.ModifierType.MOD1_MASK;
            params.accelerator = '<Control><Alt>Escape';
        }

        this._queue = [];
        this._motionDx = 0;
        this._motionDy = 0;
        this._flushId = 0;
        this._started = false;

        // Clutter.get_default_backend() was removed in GNOME 51
        const backend = global.stage.context?.get_backend() ??
            Clutter.get_default_backend();
        this._seat = backend.get_default_seat();
        this._cursorTracker = global.backend.get_cursor_tracker();
        this._cursorHidden = false;
        this._centerX = this._monitor.x + Math.floor(this._monitor.width / 2);
        this._centerY = this._monitor.y + Math.floor(this._monitor.height / 2);

        this._buildDialog(_acceleratorLabel(params.accelerator));
    }

    get device() {
        return this._device;
    }

    _buildDialog(acceleratorLabel) {
        this._actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'gsconnect-input-session-overlay',
            reactive: true,
            x: this._monitor.x,
            y: this._monitor.y,
            width: this._monitor.width,
            height: this._monitor.height,
        });

        const dialog = new St.BoxLayout({
            style_class: 'gsconnect-input-session-dialog',
            ...(HAS_ST_ORIENTATION
                ? {orientation: Clutter.Orientation.VERTICAL}
                : {vertical: true}),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._actor.add_child(dialog);

        const title = new St.Label({
            style_class: 'gsconnect-input-session-title',
            // TRANSLATORS: %s is a device name
            text: _('Sharing mouse and keyboard with %s').format(
                this._device.name),
        });
        dialog.add_child(title);

        const subtitle = new St.Label({
            style_class: 'gsconnect-input-session-subtitle',
            // TRANSLATORS: %s is a keyboard shortcut (eg. Ctrl+Alt+Escape)
            text: _('Press %s to stop sharing').format(acceleratorLabel),
        });
        dialog.add_child(subtitle);

        this._statusLabel = new St.Label({
            style_class: 'gsconnect-input-session-status',
            // TRANSLATORS: %s is a device name
            text: _('Remote keyboard on %s is not active').format(
                this._device.name),
            visible: false,
        });
        dialog.add_child(this._statusLabel);

        // TEMPORARY DEBUG: live counters, visible on the overlay itself
        this._debugCounts = {events: 0, motion: 0, key: 0, button: 0, scroll: 0, sent: 0};
        this._debugLabel = new St.Label({
            style_class: 'gsconnect-input-session-status',
            text: 'DEBUG: events=0',
        });
        dialog.add_child(this._debugLabel);
    }

    _updateDebugLabel() {
        const c = this._debugCounts;
        this._debugLabel.text =
            `DEBUG: events=${c.events} motion=${c.motion} key=${c.key} ` +
            `button=${c.button} scroll=${c.scroll} sent=${c.sent}`;
    }

    /**
     * Start the session by taking a modal grab.
     *
     * @returns {boolean} %true if the grab succeeded
     */
    start() {
        if (this._started)
            return true;

        try {
            Main.uiGroup.add_child(this._actor);

            this._grab = Main.pushModal(this._actor, {
                actionMode: Shell.ActionMode.SYSTEM_MODAL,
            });

            log(`GSConnect DEBUG start: grab=${this._grab} revoked=${this._grab?.revoked}`);

            this._capturedEventId = this._actor.connect(
                'captured-event',
                this._onCapturedEvent.bind(this)
            );
            this._actor.grab_key_focus();

            // Watch for the remote keyboard state
            this._actionStateId = this._device.action_group.connect(
                'action-state-changed',
                this._onActionStateChanged.bind(this)
            );
            this._onActionStateChanged(
                this._device.action_group,
                'remoteKeyboardState',
                this._device.action_group.get_action_state('remoteKeyboardState')
            );

            // Stop when the device disconnects or is unpaired
            this._deviceChangedId = this._device.connect(
                'g-properties-changed',
                this._onDeviceChanged.bind(this)
            );

            // Stop on session mode changes (eg. locking the screen)
            this._sessionModeId = Main.sessionMode.connect(
                'updated',
                () => this.stop()
            );

            // Park the pointer in the middle of the monitor and stream
            // relative motion from there, hiding the cursor since it's
            // only being used as a fixed reference point.
            this._seat.warp_pointer(this._centerX, this._centerY);
            this._lastX = this._centerX;
            this._lastY = this._centerY;
            this._cursorTracker.inhibit_cursor_visibility();
            this._cursorHidden = true;

            this._flushId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                FLUSH_INTERVAL,
                () => {
                    this._flush();

                    // Re-center the pointer here, outside of Clutter's
                    // event dispatch. Warping from inside the captured-event
                    // handler (ie. from _onMotion) re-enters event dispatch
                    // synchronously, which trips a Mutter consistency check
                    // and can wedge the modal grab after a single event.
                    this._seat.warp_pointer(this._centerX, this._centerY);
                    this._lastX = this._centerX;
                    this._lastY = this._centerY;

                    return GLib.SOURCE_CONTINUE;
                }
            );

            this._started = true;
            return true;
        } catch (e) {
            // Guarantee we never leave a live grab with nothing driving it
            logError(e, 'GSConnect');
            this._teardown();
            return false;
        }
    }

    /**
     * End the session, releasing the grab and destroying the dialog.
     */
    stop() {
        log(`GSConnect DEBUG stop() called, started=${this._started}`);
        console.trace('GSConnect DEBUG stop() stack');

        if (!this._started)
            return;

        this._started = false;
        this._flush();
        this._teardown();
        this._onStop();
    }

    /**
     * Release the grab and disconnect any handlers, tolerating partially
     * initialized state (eg. if start() failed partway through).
     */
    _teardown() {
        if (this._cursorHidden) {
            this._cursorTracker.uninhibit_cursor_visibility();
            this._cursorHidden = false;
        }

        if (this._flushId > 0) {
            GLib.Source.remove(this._flushId);
            this._flushId = 0;
        }

        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }

        if (this._deviceChangedId) {
            this._device.disconnect(this._deviceChangedId);
            this._deviceChangedId = 0;
        }

        if (this._actionStateId) {
            this._device.action_group.disconnect(this._actionStateId);
            this._actionStateId = 0;
        }

        if (this._capturedEventId) {
            this._actor.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        if (this._actor) {
            this._actor.destroy();
            this._actor = null;
        }
    }

    _onDeviceChanged(device, changed, invalidated) {
        const properties = changed.deepUnpack();

        if (properties.hasOwnProperty('Connected') ||
            properties.hasOwnProperty('Paired')) {
            if (!device.connected || !device.paired)
                this.stop();
        }
    }

    _onActionStateChanged(group, name, value) {
        if (name !== 'remoteKeyboardState' || this._statusLabel === null)
            return;

        const active = value instanceof GLib.Variant
            ? value.get_boolean()
            : false;
        this._statusLabel.visible = !active;
    }

    _onCapturedEvent(actor, event) {
        this._debugCounts.events++;

        switch (event.type()) {
            case Clutter.EventType.KEY_PRESS:
                this._debugCounts.key++;
                this._updateDebugLabel();
                return this._onKeyPress(event);

            case Clutter.EventType.KEY_RELEASE:
                return Clutter.EVENT_STOP;

            case Clutter.EventType.MOTION:
                this._debugCounts.motion++;
                this._updateDebugLabel();
                return this._onMotion(event);

            case Clutter.EventType.BUTTON_PRESS:
                this._debugCounts.button++;
                this._updateDebugLabel();
                return this._onButton(event, true);

            case Clutter.EventType.BUTTON_RELEASE:
                return this._onButton(event, false);

            case Clutter.EventType.SCROLL:
                this._debugCounts.scroll++;
                this._updateDebugLabel();
                return this._onScroll(event);

            default:
                this._updateDebugLabel();
                return Clutter.EVENT_STOP;
        }
    }

    _onKeyPress(event) {
        let keyval = event.get_key_symbol();
        const state = event.get_state() & DEFAULT_MOD_MASK;

        // Lowercase latin keyvals for matching the stop accelerator
        const keyvalLower = (keyval >= Clutter.KEY_A && keyval <= Clutter.KEY_Z)
            ? keyval + 32
            : keyval;

        if (keyvalLower === this._stopKeyval && state === this._stopMods) {
            this.stop();
            return Clutter.EVENT_STOP;
        }

        // Wait for a real key before sending
        if (MOD_KEYS.includes(keyval))
            return Clutter.EVENT_STOP;

        // Normalize Tab
        if (keyval === Clutter.KEY_ISO_Left_Tab)
            keyval = Clutter.KEY_Tab;

        const request = {
            alt: !!(state & Clutter.ModifierType.MOD1_MASK),
            ctrl: !!(state & Clutter.ModifierType.CONTROL_MASK),
            shift: !!(state & Clutter.ModifierType.SHIFT_MASK),
            super: !!(state & Clutter.ModifierType.SUPER_MASK),
            sendAck: false,
        };

        if (ReverseKeyMap.has(keyval)) {
            request.specialKey = ReverseKeyMap.get(keyval);
        } else {
            // Clutter.Event.get_key_unicode() returns the character itself
            // (eg. "a"), not a numeric code point
            const unicode = event.get_key_unicode();

            if (!unicode)
                return Clutter.EVENT_STOP;

            request.key = unicode;
        }

        this._queueEvent(request);

        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const [x, y] = event.get_coords();
        const dx = x - this._lastX;
        const dy = y - this._lastY;

        this._lastX = x;
        this._lastY = y;

        // The pointer is re-centered periodically by the flush timer, not
        // from here (see start()), so no warp-back-to-center events to skip
        if (dx !== 0 || dy !== 0) {
            this._motionDx += dx;
            this._motionDy += dy;
        }

        return Clutter.EVENT_STOP;
    }

    _onButton(event, pressed) {
        switch (event.get_button()) {
            case Clutter.BUTTON_PRIMARY:
                this._queueEvent(pressed
                    ? {singlehold: true}
                    : {singlerelease: true});
                break;

            case Clutter.BUTTON_MIDDLE:
                if (pressed)
                    this._queueEvent({middleclick: true});
                break;

            case Clutter.BUTTON_SECONDARY:
                if (pressed)
                    this._queueEvent({rightclick: true});
                break;
        }

        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        // Discrete events are emulated from smooth events; skip duplicates
        if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_STOP;

        const [dx, dy] = event.get_scroll_delta();

        if (dx === 0 && dy === 0)
            return Clutter.EVENT_STOP;

        this._queueEvent({
            scroll: true,
            dx: dx * 200,
            dy: dy * 200,
        });

        return Clutter.EVENT_STOP;
    }

    _queueEvent(body) {
        this._flushMotion();
        this._queue.push(body);
        this._flush();
    }

    _flushMotion() {
        if (this._motionDx === 0 && this._motionDy === 0)
            return;

        this._queue.push({
            dx: this._motionDx,
            dy: this._motionDy,
        });
        this._motionDx = 0;
        this._motionDy = 0;
    }

    _flush() {
        this._flushMotion();

        if (this._queue.length === 0)
            return;

        this._debugCounts.sent++;
        this._updateDebugLabel();

        try {
            this._device.action_group.activate_action(
                'sendEvents',
                GLib.Variant.new_string(JSON.stringify(this._queue))
            );
        } catch (e) {
            this._debugLabel.text += ` ERR:${e}`;
            logError(e, 'GSConnect DEBUG _flush');
        }

        this._queue = [];
    }
}


/**
 * Manager for sharing local mouse and keyboard input with paired devices.
 *
 * Activating a device's "Remote Input" menu item starts a modal input capture
 * session, forwarding all pointer and keyboard input to the device until the
 * stop shortcut is pressed.
 */
export class Manager {

    /**
     * @param {Gio.DBusProxy} service - The GSConnect service proxy
     */
    constructor(service) {
        this._service = service;
        this._session = null;

        this._deviceAddedId = this._service.connect(
            'device-added',
            this._onDeviceAdded.bind(this)
        );
        this._deviceRemovedId = this._service.connect(
            'device-removed',
            this._onDeviceRemoved.bind(this)
        );

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => this._session?.stop()
        );

        for (const device of this._service.devices)
            this._onDeviceAdded(this._service, device);
    }

    _onDeviceAdded(service, device) {
        try {
            // Prime the action group so action states are available
            device.action_group.list_actions();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _onDeviceRemoved(service, device) {
        try {
            if (this._session !== null && this._session.device === device)
                this._session.stop();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    /**
     * Start an input sharing session for a device, unless one is active.
     *
     * @param {Gio.DBusProxy} device - The device to forward input to
     */
    startSession(device) {
        if (this._session !== null)
            return;

        if (!device.connected || !device.paired)
            return;

        try {
            const settings = new Gio.Settings({
                settings_schema: Config.GSCHEMA.lookup(
                    'org.gnome.Shell.Extensions.GSConnect.Plugin.Mousepad',
                    true
                ),
                path: `/org/gnome/shell/extensions/gsconnect/device/${device.id}/plugin/mousepad/`,
            });
            const accelerator = settings.get_string(
                'share-input-stop-accelerator');
            settings.run_dispose();

            const session = new InputSession({
                device: device,
                accelerator: accelerator,
                monitor: Main.layoutManager.primaryMonitor,
                onStop: () => {
                    this._session = null;
                },
            });

            if (session.start())
                this._session = session;
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    destroy() {
        if (this._session !== null)
            this._session.stop();

        Main.layoutManager.disconnect(this._monitorsChangedId);
        this._service.disconnect(this._deviceAddedId);
        this._service.disconnect(this._deviceRemovedId);
    }
}
