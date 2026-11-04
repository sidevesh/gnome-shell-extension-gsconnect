// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Plugin from '../plugin.js';
import LegacyMessagingDialog from '../ui/legacyMessaging.js';
import * as Messaging from '../ui/messaging.js';
import SmsURI from '../utils/uri.js';


export const Metadata = {
    label: _('SMS'),
    description: _('Send and read SMS of the paired device and be notified of new SMS'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SMS',
    incomingCapabilities: [
        'kdeconnect.sms.messages',
    ],
    outgoingCapabilities: [
        'kdeconnect.sms.request',
        'kdeconnect.sms.request_conversation',
        'kdeconnect.sms.request_conversations',
    ],
    actions: {
        // SMS Actions
        sms: {
            label: _('Messaging'),
            icon_name: 'sms-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        uriSms: {
            label: _('New SMS (URI)'),
            icon_name: 'sms-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        replySms: {
            label: _('Reply SMS'),
            icon_name: 'sms-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        sendMessage: {
            label: _('Send Message'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('(aa{sv})'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        sendSms: {
            label: _('Send SMS'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('(ss)'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        shareSms: {
            label: _('Share SMS'),
            icon_name: 'sms-send',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
    },
};


/**
 * SMS Message event type. Currently all events are TEXT_MESSAGE.
 *
 * TEXT_MESSAGE: Has a "body" field which contains pure, human-readable text
 */
export const MessageEventType = {
    TEXT_MESSAGE: 0x1,
};


/**
 * SMS Message status. READ/UNREAD match the 'read' field from the Android App
 * message packet.
 *
 * UNREAD: A message not marked as read
 * READ: A message marked as read
 */
export const MessageStatus = {
    UNREAD: 0,
    READ: 1,
};


/**
 * SMS Message type, set from the 'type' field in the Android App
 * message packet.
 *
 * See: https://developer.android.com/reference/android/provider/Telephony.TextBasedSmsColumns.html
 *
 * ALL: all messages
 * INBOX: Received messages
 * SENT: Sent messages
 * DRAFT: Message drafts
 * OUTBOX: Outgoing messages
 * FAILED: Failed outgoing messages
 * QUEUED: Messages queued to send later
 */
export const MessageBox = {
    ALL: 0,
    INBOX: 1,
    SENT: 2,
    DRAFT: 3,
    OUTBOX: 4,
    FAILED: 5,
    QUEUED: 6,
};


/**
 * SMS Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sms
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SMSPlugin/
 */
/**
 * How many messages of a conversation to request at a time.
 */
const PAGE_SIZE = 50;

/**
 * How long after the last message of a conversation list the list is taken to
 * have arrived, in seconds. Devices send it one conversation at a time, with
 * nothing to mark its end.
 */
const LIST_SETTLE_TIME = 5;

/**
 * How long to wait for the reply to a request after the device sent an empty
 * list of messages, in seconds, before taking the empty list as the reply.
 * Devices also send one when their messages change without new ones.
 */
const EMPTY_REPLY_TIME = 10;


const SMSPlugin = GObject.registerClass({
    GTypeName: 'GSConnectSMSPlugin',
    Properties: {
        'threads': GObject.param_spec_variant(
            'threads',
            'Conversation List',
            'A list of threads',
            new GLib.VariantType('aa{sv}'),
            null,
            GObject.ParamFlags.READABLE
        ),
    },
}, class SMSPlugin extends Plugin {

    _init(device) {
        super._init(device, 'sms');

        this.cacheProperties(['_threads']);

        // Conversations whose latest or older messages were requested from
        // the device, with a number for each request, and those whose oldest
        // messages have all been received
        this._pendingThreads = new Map();
        this._pendingOlderThreads = new Map();
        this._completeThreads = new Set();
        this._requestCount = 0;

        // Waiting to take an empty list from the device as a reply
        this._emptyReplyId = 0;
        this._emptyReplyThread = null;
        this._emptyReplyTime = EMPTY_REPLY_TIME;

        // Whether a conversation list is arriving
        this._listArriving = false;
        this._listActivity = false;
        this._listId = 0;
        this._notifyId = 0;
    }

    get threads() {
        if (this._threads === undefined)
            this._threads = {};

        return this._threads;
    }

    get window() {
        if (this.settings.get_boolean('legacy-sms')) {
            return new LegacyMessagingDialog({
                device: this.device,
                plugin: this,
            });
        }

        if (this._window === undefined) {
            this._window = new Messaging.Window({
                application: Gio.Application.get_default(),
                device: this.device,
                plugin: this,
            });

            this._window.connect('destroy', () => {
                this._window = undefined;
            });
        }

        return this._window;
    }

    clearCache() {
        this._threads = {};
        this.notify('threads');
    }

    cacheLoaded() {
        this.notify('threads');
    }

    /**
     * The device only lists the conversations when the messaging window is
     * open, so it doesn't build the list on every connection; the messages it
     * sends meanwhile keep the window up to date.
     */
    connected() {
        super.connected();

        if (this._window !== undefined)
            this.requestConversations();
    }

    disconnected() {
        super.disconnected();

        // Requests that were waiting for a reply won't get one
        this._pendingThreads.clear();
        this._pendingOlderThreads.clear();
        this._cancelEmptyReply();
        this._endList();
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.sms.messages':
                this._handleMessages(packet.body.messages);
                break;
        }
    }

    /**
     * Notify that the threads changed and save them, once a burst of messages
     * has been handled.
     */
    _threadsChanged() {
        if (this._notifyId !== 0)
            return;

        this._notifyId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._notifyId = 0;
            this.notify('threads');
            this.saveCache();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Handle a new single message
     *
     * @param {object} message - A message object
     */
    _handleMessage(message) {
        let conversation = null;

        // If the window is open, try and find an active conversation
        if (this._window)
            conversation = this._window.getConversationForMessage(message);

        // If there's an active conversation, we should log the message now
        if (conversation)
            conversation.logNext(message);
    }

    /**
     * Add messages to a thread, keeping it sorted by date.
     *
     * @param {string} thread_id - The thread ID
     * @param {object[]} messages - Messages of the thread
     * @returns {number} The number of new messages
     */
    _addMessages(thread_id, messages) {
        const cache = this.threads[thread_id] || [];
        const byDate = new Map(cache.map(message => [message.date, message]));
        const lastDate = cache.length ? cache[cache.length - 1].date : -1;
        const older = [];
        let added = 0;

        for (const message of messages) {
            // TODO: We only cache messages of a known MessageBox since we
            // have no reliable way to determine its direction, let alone
            // what to do with it.
            if (message.type < 0 || message.type > 6)
                continue;

            const cacheMessage = byDate.get(message.date);

            if (cacheMessage) {
                Object.assign(cacheMessage, message);
                continue;
            }

            cache.push(message);
            byDate.set(message.date, message);
            added++;

            if (message.date <= lastDate)
                older.push(message);
        }

        if (added === 0)
            return added;

        cache.sort((a, b) => a.date - b.date);
        this.threads[thread_id] = cache;

        // If the newest message is read, so are the ones before it
        if (cache[cache.length - 1].read === MessageStatus.READ) {
            for (const message of cache)
                message.read = MessageStatus.READ;
        }

        // Show new messages in an open conversation, and give it the older
        // ones to show when scrolled back to
        for (const message of cache) {
            if (message.date > lastDate)
                this._handleMessage(message);
        }

        if (older.length > 0 && this._window) {
            const conversation = this._window.getConversationForMessage(older[0]);
            conversation?.addOlderMessages(older);
        }

        return added;
    }

    /**
     * Handle the messages a device sends: the conversation list, which comes
     * one conversation at a time, the messages of a requested conversation,
     * and new messages.
     *
     * @param {object[]} messages - A list of sms message objects
     */
    _handleMessages(messages) {
        try {
            if (messages.length === 0) {
                this._handleEmptyReply();
                return;
            }

            const threads = new Map();

            for (const message of messages) {
                // COERCION: thread_id's to strings
                message.thread_id = `${message.thread_id}`;

                // TODO: Remove bogus `insert-address-token` entries
                let a = message.addresses.length;

                while (a--) {
                    if (message.addresses[a].address === undefined ||
                        message.addresses[a].address === 'insert-address-token')
                        message.addresses.splice(a, 1);
                }

                // If there are no addresses this will cause major problems...
                if (!message.addresses[0])
                    continue;

                if (!threads.has(message.thread_id))
                    threads.set(message.thread_id, []);

                threads.get(message.thread_id).push(message);
            }

            for (const [thread_id, threadMessages] of threads)
                this._handleThreadMessages(thread_id, threadMessages);

            this._threadsChanged();
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    _handleThreadMessages(thread_id, messages) {
        const requested = this._pendingThreads.delete(thread_id);
        const requestedOlder = this._pendingOlderThreads.delete(thread_id);
        const added = this._addMessages(thread_id, messages);

        // The request an empty list was taken for was answered
        if ((requested || requestedOlder) && this._emptyReplyThread === thread_id)
            this._cancelEmptyReply();

        if (!requested && !requestedOlder)
            this._listActivity = true;

        // A page of older messages; a short one means there are no more. The
        // device includes the message the page started at.
        if (requestedOlder && added < PAGE_SIZE - 1)
            this._completeThreads.add(thread_id);
    }

    /**
     * Handle an empty list of messages from the device.
     *
     * The device sends one in reply to a request for a conversation with no
     * messages, or no older ones, but also whenever its messages change
     * without a new one, such as when one is read. So it is only taken as the
     * reply when exactly one request is waiting, and no other reply for it
     * arrives soon after.
     */
    _handleEmptyReply() {
        const requests = [
            ...[...this._pendingThreads].map(([thread_id, id]) => {
                return {thread_id, id, older: false};
            }),
            ...[...this._pendingOlderThreads].map(([thread_id, id]) => {
                return {thread_id, id, older: true};
            }),
        ];

        if (requests.length !== 1)
            return;

        const [request] = requests;

        this._cancelEmptyReply();
        this._emptyReplyThread = request.thread_id;
        this._emptyReplyId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._emptyReplyTime, () => {
                this._emptyReplyId = 0;
                this._emptyReplyThread = null;
                this._onEmptyReply(request);
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelEmptyReply() {
        if (this._emptyReplyId !== 0) {
            GLib.Source.remove(this._emptyReplyId);
            this._emptyReplyId = 0;
        }

        this._emptyReplyThread = null;
    }

    _onEmptyReply(request) {
        const {thread_id, id, older} = request;
        const pending = older ? this._pendingOlderThreads : this._pendingThreads;

        // The request was answered after all
        if (pending.get(thread_id) !== id)
            return;

        pending.delete(thread_id);

        // No older messages are left
        if (older)
            this._completeThreads.add(thread_id);
    }

    /**
     * Request the latest messages of a conversation.
     *
     * @param {string} thread_id - The id of the thread to request
     */
    _requestConversation(thread_id) {
        this._pendingThreads.set(`${thread_id}`, ++this._requestCount);

        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversation',
            body: {
                threadID: thread_id,
                numberToRequest: PAGE_SIZE,
            },
        });
    }

    /**
     * Request the latest messages of a conversation that is being opened, to
     * show those we don't have, such as the ones before the last message from
     * the conversation list.
     *
     * @param {string} thread_id - The id of the thread
     */
    refreshConversation(thread_id) {
        thread_id = `${thread_id}`;

        if (this.threads[thread_id] === undefined ||
            this._pendingThreads.has(thread_id) || !this.device.connected)
            return;

        this._requestConversation(thread_id);
    }

    /**
     * Request older messages of a conversation than those we have, unless
     * they have all been received.
     *
     * @param {string} thread_id - The id of the thread
     * @returns {boolean} If older messages were requested
     */
    requestOlderMessages(thread_id) {
        const thread = this.threads[thread_id];

        if (!thread?.length || this._completeThreads.has(thread_id) ||
            this._pendingOlderThreads.has(thread_id) || !this.device.connected)
            return false;

        this._pendingOlderThreads.set(thread_id, ++this._requestCount);
        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversation',
            body: {
                threadID: thread_id,
                rangeStartTimestamp: thread[0].date,
                numberToRequest: PAGE_SIZE,
            },
        });

        return true;
    }

    /**
     * Request the conversation list: the latest message of each unarchived
     * thread, which also has the device send new messages as they arrive.
     *
     * Only the conversation list is updated from it; the rest of a
     * conversation is requested when it is opened. A conversation the list
     * leaves out is kept, since a list cut short looks the same.
     */
    requestConversations() {
        if (!this.device.connected || this._listArriving)
            return;

        this._listArriving = true;
        this._listActivity = false;
        this._listId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW,
            LIST_SETTLE_TIME, () => {
                // Wait until the list stops arriving
                if (this._listActivity) {
                    this._listActivity = false;
                    return GLib.SOURCE_CONTINUE;
                }

                this._listId = 0;
                this._endList();
                return GLib.SOURCE_REMOVE;
            });

        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversations',
        });
    }

    _endList() {
        if (this._listId !== 0) {
            GLib.Source.remove(this._listId);
            this._listId = 0;
        }

        this._listArriving = false;
        this._listActivity = false;
    }

    /**
     * A notification action for replying to SMS messages (or missed calls).
     *
     * @param {string} hint - Could be either a contact name or phone number
     */
    replySms(hint) {
        this.window.present();
        // FIXME: causes problems now that non-numeric addresses are allowed
        // this.window.address = hint.toPhoneNumber();
    }

    /**
     * Send an SMS message
     *
     * @param {string} phoneNumber - The phone number to send the message to
     * @param {string} messageBody - The message to send
     */
    sendSms(phoneNumber, messageBody) {
        this.device.sendPacket({
            type: 'kdeconnect.sms.request',
            body: {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageBody,
            },
        });
    }

    /**
     * Send a message
     *
     * @param {object[]} addresses - A list of address objects
     * @param {string} messageBody - The message text
     * @param {number} [event] - An event bitmask
     * @param {boolean} [forceSms] - Whether to force SMS
     * @param {number} [subId] - The SIM card to use
     */
    sendMessage(addresses, messageBody, event = 1, forceSms = false, subId = undefined) {
        // TODO: waiting on support in kdeconnect-android
        // if (this._version === 1) {
        this.device.sendPacket({
            type: 'kdeconnect.sms.request',
            body: {
                sendSms: true,
                phoneNumber: addresses[0].address,
                messageBody: messageBody,
            },
        });
        // } else if (this._version === 2) {
        //     this.device.sendPacket({
        //         type: 'kdeconnect.sms.request',
        //         body: {
        //             version: 2,
        //             addresses: addresses,
        //             messageBody: messageBody,
        //             forceSms: forceSms,
        //             sub_id: subId
        //         }
        //     });
        // }
    }

    /**
     * Share a text content by SMS message. This is used by the WebExtension to
     * share URLs from the browser, but could be used to initiate sharing of any
     * text content.
     *
     * @param {string} url - The link to be shared
     */
    shareSms(url) {
        // Legacy Mode
        if (this.settings.get_boolean('legacy-sms')) {
            const window = this.window;
            window.present();
            window.setMessage(url);

        // If there are active threads, show the chooser dialog
        } else if (Object.values(this.threads).length > 0) {
            this.requestConversations();

            const window = new Messaging.ConversationChooser({
                application: Gio.Application.get_default(),
                device: this.device,
                message: url,
                plugin: this,
            });

            window.present();

        // Otherwise show the window and wait for a contact to be chosen
        } else {
            this.window.present();
            this.window.setMessage(url, true);
        }
    }

    /**
     * Open and present the messaging window
     */
    sms() {
        this.window.present();
    }

    /**
     * This is the sms: URI scheme handler
     *
     * @param {string} uri - The URI the handle (sms:|sms://|sms:///)
     */
    uriSms(uri) {
        try {
            uri = new SmsURI(uri);

            // Lookup contacts
            const addresses = uri.recipients.map(number => {
                return {address: number.toPhoneNumber()};
            });
            const contacts = this.device.contacts.lookupAddresses(addresses);

            // Present the window and show the conversation
            const window = this.window;
            window.present();
            window.setContacts(contacts);

            // Set the outgoing message if the uri has a body variable
            if (uri.body)
                window.setMessage(uri.body);
        } catch (e) {
            debug(e, `${this.device.name}: "${uri}"`);
        }
    }

    _threadHasAddress(thread, addressObj) {
        for (const taddressObj of thread[0].addresses) {
            if (addressObj.address?.equalsPhoneNumber(taddressObj.address))
                return true;
        }
        return false;
    }

    /**
     * Try to find a thread_id in for {@link addresses}.
     *
     * @param {object[]} addresses - a list of address objects
     * @returns {string|null} a thread ID
     */
    getThreadIdForAddresses(addresses = []) {
        const threads = Object.values(this.threads);

        for (const thread of threads) {
            if (addresses.length !== thread[0].addresses.length)
                continue;

            if (addresses.every(addressObj => this._threadHasAddress(thread, addressObj)))
                return thread[0].thread_id;
        }

        return null;
    }

    destroy() {
        if (this._window !== undefined)
            this._window.destroy();

        this._cancelEmptyReply();
        this._endList();

        if (this._notifyId !== 0) {
            GLib.Source.remove(this._notifyId);
            this._notifyId = 0;
        }

        super.destroy();
    }
});

export default SMSPlugin;
