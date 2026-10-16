// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import Config from '../config.js';


/**
 * How far the pointer has to be pushed against the edge, in pixels, and
 * within how long, in ms, to move to the device. Each movement counts for at
 * most PRESSURE_STEP pixels, so the pointer has to be pushed for a moment:
 * flicking it to the edge, eg. to reach a dock, doesn't move it.
 */
const PRESSURE_THRESHOLD = 100;
const PRESSURE_TIMEOUT = 1000;
const PRESSURE_STEP = 15;

/**
 * The interval, in ms, at which captured input is sent to the device.
 */
const FLUSH_INTERVAL = 16;

/**
 * The shortcut that takes the pointer back if the device's Stop Sharing
 * Shortcut can't be read: Ctrl+Alt+Escape.
 */
const DEFAULT_STOP_KEYVAL = Clutter.KEY_Escape;
const DEFAULT_STOP_MODS = Clutter.ModifierType.CONTROL_MASK |
                          Clutter.ModifierType.MOD1_MASK;

const MOD_MASK = Clutter.ModifierType.SHIFT_MASK |
                 Clutter.ModifierType.CONTROL_MASK |
                 Clutter.ModifierType.MOD1_MASK |
                 Clutter.ModifierType.SUPER_MASK;

/**
 * A map of Clutter keyvals to KDE Connect's special keys.
 */
const SpecialKeys = new Map([
    [Clutter.KEY_BackSpace, 1],
    [Clutter.KEY_Tab, 2],
    [Clutter.KEY_ISO_Left_Tab, 2],
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
    [Clutter.KEY_KP_Enter, 12],
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

const MODIFIER_KEYS = new Set([
    Clutter.KEY_Alt_L,
    Clutter.KEY_Alt_R,
    Clutter.KEY_Caps_Lock,
    Clutter.KEY_Control_L,
    Clutter.KEY_Control_R,
    Clutter.KEY_ISO_Level3_Shift,
    Clutter.KEY_Meta_L,
    Clutter.KEY_Meta_R,
    Clutter.KEY_Num_Lock,
    Clutter.KEY_Shift_L,
    Clutter.KEY_Shift_R,
    Clutter.KEY_Super_L,
    Clutter.KEY_Super_R,
]);


/**
 * Get the default seat. Clutter.get_default_backend() was removed in GNOME 51.
 *
 * @returns {Clutter.Seat} The seat
 */
function getSeat() {
    const backend = global.stage.context?.get_backend() ??
        Clutter.get_default_backend();

    return backend.get_default_seat();
}


/**
 * Get the parts of an edge of the screen layout: one for each monitor that
 * touches that edge of the bounding box of all monitors.
 *
 * @param {object[]} monitors - The monitors, with x, y, width and height
 * @param {string} edge - The edge: 'left', 'right', 'top' or 'bottom'
 * @returns {object[]} The segments, with x1, y1, x2 and y2, from the start
 *   of the edge (its top or left end)
 */
export function getEdgeSegments(monitors, edge) {
    const left = Math.min(...monitors.map(m => m.x));
    const top = Math.min(...monitors.map(m => m.y));
    const right = Math.max(...monitors.map(m => m.x + m.width));
    const bottom = Math.max(...monitors.map(m => m.y + m.height));

    switch (edge) {
        case 'left':
            return monitors.filter(m => m.x === left).map(m => ({
                x1: left, y1: m.y, x2: left, y2: m.y + m.height,
            }));

        case 'right':
            return monitors.filter(m => m.x + m.width === right).map(m => ({
                x1: right, y1: m.y, x2: right, y2: m.y + m.height,
            }));

        case 'top':
            return monitors.filter(m => m.y === top).map(m => ({
                x1: m.x, y1: top, x2: m.x + m.width, y2: top,
            }));

        case 'bottom':
            return monitors.filter(m => m.y + m.height === bottom).map(m => ({
                x1: m.x, y1: bottom, x2: m.x + m.width, y2: bottom,
            }));
    }

    return [];
}


/**
 * Find the segment of an edge nearest to a point.
 *
 * @param {object[]} segments - Edge segments, from getEdgeSegments()
 * @param {number} x - The point's x coordinate
 * @param {number} y - The point's y coordinate
 * @returns {object} The nearest segment
 */
export function findSegment(segments, x, y) {
    const distance = s => {
        const cx = Math.min(Math.max(x, s.x1), s.x2);
        const cy = Math.min(Math.max(y, s.y1), s.y2);
        return Math.hypot(x - cx, y - cy);
    };

    return segments.reduce((a, b) => (distance(b) < distance(a) ? b : a));
}


/**
 * Get the point of an edge segment a device handed the pointer back at.
 *
 * The device gives its position relative to the start of the edge. The
 * point is moved just inside the screen, so the pointer doesn't land on the
 * edge it has to be pushed against again to leave.
 *
 * @param {object} segment - The edge segment the pointer left from
 * @param {string} edge - The edge
 * @param {number} dx - The horizontal distance from the start of the edge
 * @param {number} dy - The vertical distance from the start of the edge
 * @returns {number[]} The point
 */
export function getReleasePoint(segment, edge, dx, dy) {
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    let x = clamp(segment.x1 + dx, segment.x1, segment.x2);
    let y = clamp(segment.y1 + dy, segment.y1, segment.y2);

    switch (edge) {
        case 'left':
            x += 1;
            y = Math.min(y, segment.y2 - 1);
            break;

        case 'right':
            x -= 2;
            y = Math.min(y, segment.y2 - 1);
            break;

        case 'top':
            y += 1;
            x = Math.min(x, segment.x2 - 1);
            break;

        case 'bottom':
            y -= 2;
            x = Math.min(x, segment.x2 - 1);
            break;
    }

    return [x, y];
}


/**
 * Parse an accelerator in the form returned by Gtk.accelerator_name() into a
 * keyval and modifier mask that can be matched against Clutter key events.
 *
 * @param {string} accelerator - An accelerator (eg. '<Control><Alt>Escape')
 * @returns {number[]} A [keyval, modifiers] pair, [0, 0] on failure
 */
function parseAccelerator(accelerator) {
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
 * Get the shortcut that takes the pointer back from a device: its Stop
 * Sharing Shortcut, or Ctrl+Alt+Escape if that can't be read, so there is
 * always a way back.
 *
 * @param {object} device - A device, from Remote.Service
 * @returns {number[]} A [keyval, modifiers] pair
 */
function getStopShortcut(device) {
    try {
        const settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Plugin.Mousepad',
                true
            ),
            path: `/org/gnome/shell/extensions/gsconnect/device/${device.id}/plugin/mousepad/`,
        });
        const accelerator = settings.get_string('share-input-stop-accelerator');
        settings.run_dispose();

        const [keyval, mods] = parseAccelerator(accelerator);

        if (keyval !== 0)
            return [keyval, mods];
    } catch (e) {
        logError(e, 'GSConnect');
    }

    return [DEFAULT_STOP_KEYVAL, DEFAULT_STOP_MODS];
}


/**
 * Barriers along an edge of the screen, triggered by pushing the pointer
 * against them for a moment.
 */
class EdgeBarrier {

    /**
     * @param {object[]} segments - Edge segments, from getEdgeSegments()
     * @param {string} edge - The edge
     * @param {() => void} onTrigger - Called when the edge is pushed against
     */
    constructor(segments, edge, onTrigger) {
        this._onTrigger = onTrigger;
        this._events = [];
        this._barriers = [];

        const directions = {
            left: Meta.BarrierDirection.POSITIVE_X,
            right: Meta.BarrierDirection.NEGATIVE_X,
            top: Meta.BarrierDirection.POSITIVE_Y,
            bottom: Meta.BarrierDirection.NEGATIVE_Y,
        }[edge];
        const horizontal = edge === 'top' || edge === 'bottom';

        for (const segment of segments) {
            const barrier = new Meta.Barrier({
                backend: global.backend,
                ...segment,
                directions,
            });

            barrier.connect('hit', (barrier_, event) => {
                this._onHit(event, horizontal);
            });
            barrier.connect('left', () => this.reset());
            this._barriers.push(barrier);
        }
    }

    get length() {
        return this._barriers.length;
    }

    reset() {
        this._events = [];
    }

    _onHit(event, horizontal) {
        // Not while a modal dialog, the lock screen or a capture is active
        if (!(Main.actionMode & (Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW)))
            return;

        const across = Math.abs(horizontal ? event.dy : event.dx);
        const along = Math.abs(horizontal ? event.dx : event.dy);

        // Sliding along the edge isn't pushing against it
        if (along > across)
            return;

        this._events = this._events.filter(([time]) => {
            return time > event.time - PRESSURE_TIMEOUT;
        });
        this._events.push([event.time, Math.min(across, PRESSURE_STEP)]);

        const pressure = this._events.reduce((sum, [, d]) => sum + d, 0);

        if (pressure >= PRESSURE_THRESHOLD) {
            this.reset();
            this._onTrigger();
        }
    }

    destroy() {
        for (const barrier of this._barriers)
            barrier.destroy();

        this._barriers = [];
    }
}


/**
 * Capture all pointer and keyboard input with a modal grab, and send it to a
 * device until it hands the pointer back or the session is stopped.
 *
 * Nothing is shown: the cursor is hidden, as it has moved to the device.
 *
 * Pointer motion is measured from the hidden pointer's position, which is moved
 * back to the middle of the screen whenever it strays from it. That is done
 * from a timer, never from an event handler: warping while Clutter dispatches
 * an event has broken the grab before. (Clutter.Event.get_relative_motion()
 * can't be called from GJS, as its out arguments aren't annotated.)
 */
class CaptureSession {

    /**
     * @param {object} params - Parameters
     * @param {object} params.device - The device, from Remote.Service
     * @param {number[]} params.exitPoint - Where the pointer left the screen
     * @param {(point: number[]) => void} params.onStop - Called when the
     *   session ends, with where to put the pointer
     */
    constructor(params) {
        this.device = params.device;
        this._exitPoint = params.exitPoint;
        this._onStop = params.onStop;

        // Read when the pointer moves to the device, so a changed shortcut
        // applies from the next time
        [this._stopKeyval, this._stopMods] = getStopShortcut(this.device);

        this._queue = [];
        this._motionDx = 0;
        this._motionDy = 0;
        this._flushId = 0;
        this._started = false;
        this._lastCoords = null;
    }

    /**
     * Start capturing input.
     *
     * @returns {boolean} %true if the capture started
     */
    start() {
        try {
            const monitors = Main.layoutManager.monitors;
            const left = Math.min(...monitors.map(m => m.x));
            const top = Math.min(...monitors.map(m => m.y));

            // An invisible actor over every monitor to hold the grab
            this._actor = new St.Widget({
                reactive: true,
                can_focus: true,
                x: left,
                y: top,
                width: Math.max(...monitors.map(m => m.x + m.width)) - left,
                height: Math.max(...monitors.map(m => m.y + m.height)) - top,
            });
            Main.uiGroup.add_child(this._actor);

            this._grab = Main.pushModal(this._actor, {
                actionMode: Shell.ActionMode.SYSTEM_MODAL,
            });

            this._capturedEventId = this._actor.connect('captured-event',
                this._onCapturedEvent.bind(this));
            this._actor.grab_key_focus();

            // Give the pointer back if the device goes away or the screen
            // is locked
            this._deviceChangedId = this.device.connect('g-properties-changed',
                () => {
                    if (!this.device.connected || !this.device.paired)
                        this.stop();
                });
            this._sessionModeId = Main.sessionMode.connect('updated',
                () => this.stop());

            // Hide the cursor while over the grab actor. Inhibiting the cursor
            // with Meta.CursorTracker instead stops pointer events reaching
            // the grab, as of GNOME 51.
            this._actor.set_cursor_type?.(Clutter.CursorType.NONE);

            // Measure motion from the middle of the primary monitor
            const primary = Main.layoutManager.primaryMonitor;
            this._center = [
                primary.x + Math.floor(primary.width / 2),
                primary.y + Math.floor(primary.height / 2),
            ];
            this._size = [primary.width, primary.height];
            this._recenter();

            this._flushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                FLUSH_INTERVAL, () => {
                    this._flush();
                    this._maybeRecenter();
                    return GLib.SOURCE_CONTINUE;
                });

            this._started = true;
            return true;
        } catch (e) {
            // Never leave a grab behind with nothing driving it
            logError(e, 'GSConnect');
            this._teardown();
            return false;
        }
    }

    /**
     * Stop capturing input.
     *
     * @param {number[]} [point] - Where to put the pointer, if it was handed
     *   back by the device; otherwise it goes back where it left
     */
    stop(point = null) {
        if (!this._started)
            return;

        this._started = false;
        this._flush();
        this._teardown();
        this._onStop(point ?? this._exitPoint);
    }

    /**
     * Move the pointer back to the middle of the primary monitor.
     *
     * Motion events still queued from before the move may arrive after it,
     * or be merged by Clutter with the first one after it, so the motion up
     * to where the pointer is now is counted here instead. Those events are
     * then far from the middle, and ignored (see _onMotion()).
     *
     * @param {number[]} [pointer] - Where the pointer is now, unless the
     *   session is starting
     */
    _recenter(pointer = null) {
        if (pointer !== null) {
            this._motionDx += pointer[0] - this._lastCoords[0];
            this._motionDy += pointer[1] - this._lastCoords[1];
        }

        getSeat().warp_pointer(...this._center);
        this._lastCoords = [...this._center];
        this._recentered = true;
    }

    /**
     * Whether a position is more than a fraction of the primary monitor's
     * size away from its middle.
     *
     * @param {number[]} point - A position
     * @param {number} fraction - The fraction of the monitor's size
     * @returns {boolean} %true if the position is that far away
     */
    _isAwayFromCenter([x, y], fraction) {
        return Math.abs(x - this._center[0]) > this._size[0] * fraction ||
            Math.abs(y - this._center[1]) > this._size[1] * fraction;
    }

    _maybeRecenter() {
        const pointer = global.get_pointer().slice(0, 2);

        // Leave a quarter of the monitor for the pointer to move in before
        // the next check, so it never stops at an edge
        if (this._isAwayFromCenter(pointer, 1 / 4))
            this._recenter(pointer);
    }

    _teardown() {
        if (this._flushId) {
            GLib.Source.remove(this._flushId);
            this._flushId = 0;
        }

        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }

        if (this._deviceChangedId) {
            this.device.disconnect(this._deviceChangedId);
            this._deviceChangedId = 0;
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

    _onCapturedEvent(actor, event) {
        switch (event.type()) {
            case Clutter.EventType.KEY_PRESS:
                this._onKeyPress(event);
                break;

            case Clutter.EventType.MOTION:
                this._onMotion(event);
                break;

            case Clutter.EventType.BUTTON_PRESS:
                this._onButton(event, true);
                break;

            case Clutter.EventType.BUTTON_RELEASE:
                this._onButton(event, false);
                break;

            case Clutter.EventType.SCROLL:
                this._onScroll(event);
                break;

            // Crossing events must propagate
            case Clutter.EventType.ENTER:
            case Clutter.EventType.LEAVE:
                return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_STOP;
    }

    _onKeyPress(event) {
        const keyval = event.get_key_symbol();
        const state = event.get_state() & MOD_MASK;

        // The shortcut is stored with a lowercase letter, eg. <Control>q,
        // while the key event has an uppercase one if Shift is held
        const keyvalLower = keyval >= Clutter.KEY_A && keyval <= Clutter.KEY_Z
            ? keyval + (Clutter.KEY_a - Clutter.KEY_A)
            : keyval;

        if (keyvalLower === this._stopKeyval && state === this._stopMods) {
            this.stop();
            return;
        }

        if (MODIFIER_KEYS.has(keyval))
            return;

        const request = {
            shift: Boolean(state & Clutter.ModifierType.SHIFT_MASK),
            ctrl: Boolean(state & Clutter.ModifierType.CONTROL_MASK),
            alt: Boolean(state & Clutter.ModifierType.MOD1_MASK),
            super: Boolean(state & Clutter.ModifierType.SUPER_MASK),
        };

        if (keyval === Clutter.KEY_ISO_Left_Tab)
            request.shift = true;

        if (SpecialKeys.has(keyval)) {
            request.specialKey = SpecialKeys.get(keyval);
        } else {
            // The character itself, eg. "a"
            const unicode = event.get_key_unicode();

            if (!unicode)
                return;

            request.key = unicode;
        }

        this._queueEvent(request);
    }

    _onMotion(event) {
        const [x, y] = event.get_coords();

        // Motion from before the pointer was moved back to the middle has
        // already been counted (see _recenter())
        if (this._recentered) {
            if (this._isAwayFromCenter([x, y], 1 / 8))
                return;

            this._recentered = false;
        }

        this._motionDx += x - this._lastCoords[0];
        this._motionDy += y - this._lastCoords[1];
        this._lastCoords = [x, y];
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
    }

    _onScroll(event) {
        // Discrete events are emulated from smooth ones
        if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH)
            return;

        const [dx, dy] = event.get_scroll_delta();

        // The same scale GSConnect's input window uses
        if (dx !== 0 || dy !== 0)
            this._queueEvent({scroll: true, dx: dx * 200, dy: dy * 200});
    }

    _queueEvent(body) {
        this._flushMotion();
        this._queue.push(body);
        this._flush();
    }

    _flushMotion() {
        if (this._motionDx === 0 && this._motionDy === 0)
            return;

        this._queue.push({dx: this._motionDx, dy: this._motionDy});
        this._motionDx = 0;
        this._motionDy = 0;
    }

    _flush() {
        this._flushMotion();

        if (this._queue.length === 0)
            return;

        const events = JSON.stringify(this._queue);
        this._queue = [];

        try {
            this.device.action_group.activate_action('shareInputEvents',
                new GLib.Variant('s', events));
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }
}


/**
 * Lets the pointer move off a screen edge onto a device and back, for each
 * connected device with the Share Input Devices plugin enabled.
 *
 * Pushing the pointer against the edge configured for a device moves it to
 * the device; KDE Connect for Android hands it back when it is moved off the
 * same edge on the device. The device's Stop Sharing Shortcut always takes it
 * back.
 */
export class Manager {

    /**
     * @param {object} service - The GSConnect service, from Remote.Service
     */
    constructor(service) {
        this._service = service;
        this._devices = new Map();
        this._barriers = [];
        this._session = null;
        this._sessionSegment = null;
        this._sessionEdge = null;
        this._rebuildId = 0;

        this._deviceAddedId = service.connect('device-added',
            (service_, device) => this._addDevice(device));
        this._deviceRemovedId = service.connect('device-removed',
            (service_, device) => this._removeDevice(device));
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => {
                this._session?.stop();
                this._queueRebuild();
            });

        for (const device of service.devices)
            this._addDevice(device);
    }

    _addDevice(device) {
        if (this._devices.has(device))
            return;

        const group = device.action_group;
        const ids = [
            group.connect('action-added', () => this._queueRebuild()),
            group.connect('action-removed', () => this._queueRebuild()),
            group.connect('action-enabled-changed', () => this._queueRebuild()),
            group.connect('action-state-changed',
                (group_, name, value) => this._onStateChanged(device, name, value)),
        ];

        this._devices.set(device, ids);
        this._queueRebuild();
    }

    _removeDevice(device) {
        const ids = this._devices.get(device);

        if (ids === undefined)
            return;

        if (this._session?.device === device)
            this._session.stop();

        for (const id of ids)
            device.action_group.disconnect(id);

        this._devices.delete(device);
        this._queueRebuild();
    }

    _onStateChanged(device, name, value) {
        if (name === 'shareInputEdge') {
            this._queueRebuild();
            return;
        }

        // The device handed the pointer back
        if (name === 'shareInputRelease' && this._session?.device === device) {
            const [, dx, dy] = value.deepUnpack();
            const point = getReleasePoint(this._sessionSegment,
                this._sessionEdge, dx, dy);

            this._session.stop(point);
        }
    }

    /**
     * Get the edge configured for a device, if it can receive the pointer.
     *
     * @param {object} device - A device, from Remote.Service
     * @returns {string|null} The edge, or %null
     */
    _getDeviceEdge(device) {
        const group = device.action_group;

        if (!group.has_action('shareInputEdge') ||
            !group.get_action_enabled('shareInputEdge') ||
            !group.get_action_enabled('shareInputEnter'))
            return null;

        return group.get_action_state('shareInputEdge')?.unpack() ?? null;
    }

    _queueRebuild() {
        if (this._rebuildId !== 0)
            return;

        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._rebuildId = 0;
            this._rebuildBarriers();
            return GLib.SOURCE_REMOVE;
        });
    }

    _destroyBarriers() {
        for (const barrier of this._barriers)
            barrier.destroy();

        this._barriers = [];
    }

    /**
     * Put a barrier along the edge configured for each device. If devices
     * share an edge, the first one gets it.
     */
    _rebuildBarriers() {
        this._destroyBarriers();

        const monitors = Main.layoutManager.monitors;
        const usedEdges = new Set();

        if (monitors.length === 0)
            return;

        for (const device of this._devices.keys()) {
            const edge = this._getDeviceEdge(device);

            if (edge === null || usedEdges.has(edge))
                continue;

            usedEdges.add(edge);

            const segments = getEdgeSegments(monitors, edge);

            // Start capturing outside of the barrier's event handling, which
            // would otherwise keep pointer events from reaching the grab
            this._barriers.push(new EdgeBarrier(segments, edge, () => {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._onTrigger(device, edge, segments);
                    return GLib.SOURCE_REMOVE;
                });
            }));
        }
    }

    _onTrigger(device, edge, segments) {
        if (this._session !== null || this._getDeviceEdge(device) !== edge)
            return;

        const [x, y] = global.get_pointer();
        const segment = findSegment(segments, x, y);
        const session = new CaptureSession({
            device: device,
            exitPoint: getReleasePoint(segment, edge, x - segment.x1,
                y - segment.y1),
            onStop: point => {
                this._session = null;

                for (const barrier of this._barriers)
                    barrier.reset();

                // Put the pointer back, outside of any event handler
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    getSeat().warp_pointer(...point);
                    return GLib.SOURCE_REMOVE;
                });
            },
        });

        if (!session.start())
            return;

        this._session = session;
        this._sessionSegment = segment;
        this._sessionEdge = edge;

        // Tell the device where along the edge the pointer left
        device.action_group.activate_action('shareInputEnter',
            new GLib.Variant('(dd)', [x - segment.x1, y - segment.y1]));
    }

    destroy() {
        this._session?.stop();

        if (this._rebuildId !== 0) {
            GLib.Source.remove(this._rebuildId);
            this._rebuildId = 0;
        }

        for (const device of [...this._devices.keys()])
            this._removeDevice(device);

        this._destroyBarriers();

        Main.layoutManager.disconnect(this._monitorsChangedId);
        this._service.disconnect(this._deviceAddedId);
        this._service.disconnect(this._deviceRemovedId);
    }
}
