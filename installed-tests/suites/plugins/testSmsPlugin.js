// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';


const SMS_CAPABILITIES = [
    'kdeconnect.sms.messages',
    'kdeconnect.sms.request',
    'kdeconnect.sms.request_conversation',
    'kdeconnect.sms.request_conversations',
];

const BASE_DATE = 1588334621000;


/**
 * Create a message object as KDE Connect for Android sends them.
 *
 * @param {number} thread_id - The thread ID
 * @param {number} n - The message's position in the thread
 * @returns {object} A message object
 */
function createMessage(thread_id, n) {
    return {
        addresses: [{address: `555-555-000${thread_id}`}],
        body: `message ${n} of thread ${thread_id}`,
        date: BASE_DATE + thread_id * 100000 + n * 10,
        type: n % 2 ? 2 : 1,
        read: 1,
        thread_id: thread_id,
        _id: thread_id * 1000 + n,
        sub_id: 1,
        event: 1,
    };
}


/**
 * A fake phone, answering requests like KDE Connect for Android does.
 */
class FakePhone {
    constructor(device) {
        this.device = device;
        this.threads = new Map([
            [1, [createMessage(1, 0), createMessage(1, 1)]],
            [2, [createMessage(2, 0)]],
            [3, Array.from({length: 120}, (_, n) => createMessage(3, n))],
        ]);
    }

    send(messages) {
        this.device.sendPacket({
            type: 'kdeconnect.sms.messages',
            body: {messages: messages, version: 2},
        });
    }

    handlePacket(packet) {
        switch (packet.type) {
            // One packet for each conversation, with its latest message
            case 'kdeconnect.sms.request_conversations':
                for (const messages of this.threads.values())
                    this.send([messages[messages.length - 1]]);
                break;

            // The newest messages at or before the start, up to the number
            case 'kdeconnect.sms.request_conversation': {
                const messages = this.threads.get(Number(packet.body.threadID)) ?? [];
                const start = packet.body.rangeStartTimestamp ?? Infinity;
                const number = packet.body.numberToRequest ?? messages.length;

                this.send(messages
                    .filter(message => message.date <= start)
                    .sort((a, b) => b.date - a.date)
                    .slice(0, number));
                break;
            }
        }
    }
}


/**
 * Iterate the main loop until a condition is met.
 *
 * @param {() => boolean} condition - Returns true when done waiting
 */
async function waitFor(condition) {
    while (!condition())
        await Promise.idle(GLib.PRIORITY_DEFAULT_IDLE);
}


describe('The sms plugin', function () {
    let testRig;
    let localPlugin;
    let remoteDevice;
    let phone;

    /**
     * Request the conversation list and wait for it to arrive.
     */
    async function listConversations() {
        localPlugin.requestConversations();

        await waitFor(() => {
            return [...phone.threads].every(([id, messages]) => {
                const thread = localPlugin.threads[`${id}`];
                const latest = messages[messages.length - 1];

                return thread?.some(message => message.date === latest.date);
            });
        });

        // Let the last replies through
        for (let i = 0; i < 5; i++)
            await Promise.idle(GLib.PRIORITY_DEFAULT_IDLE);

        localPlugin._endList();
    }

    /**
     * Request the latest messages of conversations and wait for them.
     *
     * @param {...string} ids - Thread IDs
     */
    async function openConversations(...ids) {
        for (const id of ids)
            localPlugin.refreshConversation(id);

        await waitFor(() => localPlugin._pendingThreads.size === 0);
    }

    /**
     * Get the IDs of the cached messages of a conversation.
     *
     * @param {string} thread_id - The thread ID
     * @returns {number[]} The message IDs
     */
    function messageIds(thread_id) {
        return localPlugin.threads[thread_id].map(message => message._id);
    }

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: SMS_CAPABILITIES,
                outgoingCapabilities: SMS_CAPABILITIES,
            },
            remoteDevice: {
                incomingCapabilities: SMS_CAPABILITIES,
                outgoingCapabilities: SMS_CAPABILITIES,
            },
        });
        testRig.setPaired(true);

        remoteDevice = testRig.remoteDevice;
        phone = new FakePhone(remoteDevice);
        remoteDevice.handlePacket = phone.handlePacket.bind(phone);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin) {
            spyOn(localPlugin, 'handlePacket').and.callThrough();
            spyOn(remoteDevice, 'handlePacket').and.callThrough();
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('sms');

        expect(localPlugin).toBeDefined();
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        for (const action in localPlugin._meta.actions)
            expect(localPlugin.device.get_action_enabled(action)).toBeTrue();
    });

    it('does not request messages when connected', function () {
        spyOn(localPlugin, 'requestConversations');

        localPlugin.connected();
        expect(localPlugin.requestConversations).not.toHaveBeenCalled();
    });

    it('requests the conversations when connected with the window open', function () {
        spyOn(localPlugin, 'requestConversations');

        localPlugin._window = {getConversationForMessage: () => null};
        localPlugin.connected();
        localPlugin._window = undefined;

        expect(localPlugin.requestConversations).toHaveBeenCalled();
    });

    it('lists conversations without requesting them', async function () {
        await listConversations();

        expect(remoteDevice.handlePacket).toHaveBeenCalledTimes(1);
        expect(remoteDevice.handlePacket).not.toHaveBeenCalledWith(
            jasmine.objectContaining({
                type: 'kdeconnect.sms.request_conversation',
            }));

        expect(messageIds('1')).toEqual([1001]);
        expect(messageIds('2')).toEqual([2000]);
        expect(messageIds('3')).toEqual([3119]);
    });

    it('does not request the list again while it arrives', async function () {
        localPlugin.requestConversations();
        localPlugin.requestConversations();

        await waitFor(() => remoteDevice.handlePacket.calls.count() > 0);
        for (let i = 0; i < 5; i++)
            await Promise.idle(GLib.PRIORITY_DEFAULT_IDLE);
        localPlugin._endList();

        const lists = remoteDevice.handlePacket.calls.allArgs().filter(([packet]) => {
            return packet.type === 'kdeconnect.sms.request_conversations';
        });
        expect(lists.length).toBe(1);
    });

    it('requests the latest messages of an opened conversation', async function () {
        await openConversations('1', '3');

        for (const id of ['1', '3']) {
            expect(remoteDevice.handlePacket).toHaveBeenCalledWith(
                jasmine.objectContaining({
                    type: 'kdeconnect.sms.request_conversation',
                    body: {threadID: id, numberToRequest: 50},
                }));
        }

        expect(messageIds('1')).toEqual([1000, 1001]);

        // Only the latest page of a long conversation, in order
        const thread = localPlugin.threads['3'];
        expect(thread.length).toBe(50);
        expect(thread[0].body).toBe('message 70 of thread 3');
        expect(thread[49].body).toBe('message 119 of thread 3');
    });

    it('gets the messages a list skips when the conversation is opened', async function () {
        phone.threads.get(1).push(createMessage(1, 2), createMessage(1, 3));

        await listConversations();
        expect(messageIds('1')).toEqual([1000, 1001, 1003]);

        await openConversations('1');
        expect(messageIds('1')).toEqual([1000, 1001, 1002, 1003]);
    });

    it('requests older messages a page at a time', async function () {
        const plugin = localPlugin;

        while (plugin.requestOlderMessages('3')) {
            const length = plugin.threads['3'].length;

            await waitFor(() => {
                return !plugin._pendingOlderThreads.has('3') &&
                    plugin.threads['3'].length >= length;
            });
        }

        const thread = localPlugin.threads['3'];
        expect(thread.length).toBe(120);
        expect(thread[0].body).toBe('message 0 of thread 3');
        expect(localPlugin._completeThreads.has('3')).toBeTrue();

        // The first request started at the oldest message it had
        expect(remoteDevice.handlePacket).toHaveBeenCalledWith(
            jasmine.objectContaining({
                type: 'kdeconnect.sms.request_conversation',
                body: {
                    threadID: '3',
                    rangeStartTimestamp: createMessage(3, 70).date,
                    numberToRequest: 50,
                },
            }));
    });

    it('keeps conversations a list leaves out', async function () {
        const thread = phone.threads.get(2);
        phone.threads.delete(2);

        await listConversations();
        phone.threads.set(2, thread);

        expect(localPlugin.threads['2']).toBeDefined();
    });

    it('removes messages deleted on the device when opening', async function () {
        const deleted = [createMessage(1, 1), createMessage(3, 100)];

        phone.threads.set(1, phone.threads.get(1).filter(message => {
            return message._id !== deleted[0]._id;
        }));
        phone.threads.set(3, phone.threads.get(3).filter(message => {
            return message._id !== deleted[1]._id;
        }));

        await openConversations('1', '3');

        expect(messageIds('1')).toEqual([1000, 1002, 1003]);
        expect(messageIds('3').length).toBe(119);
        expect(messageIds('3')).not.toContain(deleted[1]._id);
    });

    it('removes deleted messages when loading older ones', async function () {
        const deleted = createMessage(3, 30);

        phone.threads.set(3, phone.threads.get(3).filter(message => {
            return message._id !== deleted._id;
        }));

        // As if only the messages from the deleted one on were loaded
        localPlugin.threads['3'] = localPlugin.threads['3'].filter(message => {
            return message.date >= deleted.date;
        });
        localPlugin._completeThreads.delete('3');

        expect(localPlugin.requestOlderMessages('3')).toBeTrue();
        await waitFor(() => !localPlugin._pendingOlderThreads.has('3'));

        const thread = localPlugin.threads['3'];
        expect(thread.length).toBe(118);
        expect(thread.map(message => message._id)).not.toContain(deleted._id);
        expect(thread[0].body).toBe('message 0 of thread 3');
    });

    it('keeps messages when a new one arrives while opening', async function () {
        const message = createMessage(1, 4);
        phone.threads.get(1).push(message);

        // The new message arrives before the requested page
        localPlugin._pendingThreads.set('1', 0);
        phone.send([message]);
        await waitFor(() => localPlugin.threads['1'].length === 4);
        localPlugin._pendingThreads.delete('1');

        expect(messageIds('1')).toEqual([1000, 1002, 1003, 1004]);
    });

    it('removes a conversation the device has no messages for', async function () {
        localPlugin._emptyReplyTime = 0;
        phone.threads.delete(2);

        localPlugin.refreshConversation('2');
        await waitFor(() => localPlugin.threads['2'] === undefined);

        // It asked twice before removing it
        const requests = remoteDevice.handlePacket.calls.allArgs().filter(([packet]) => {
            return packet.type === 'kdeconnect.sms.request_conversation' &&
                packet.body.threadID === '2';
        });
        expect(requests.length).toBe(2);
        expect(localPlugin.threads['1']).toBeDefined();
    });

    it('keeps a conversation when an empty list is not the reply', async function () {
        localPlugin._emptyReplyTime = 0;

        // An empty list the device sent because a message was read
        localPlugin.refreshConversation('1');
        localPlugin.handlePacket({
            type: 'kdeconnect.sms.messages',
            body: {messages: []},
        });

        await waitFor(() => localPlugin._pendingThreads.size === 0);
        for (let i = 0; i < 5; i++)
            await Promise.idle(GLib.PRIORITY_DEFAULT_IDLE);

        expect(localPlugin.threads['1']).toBeDefined();
        expect(localPlugin._emptyReplyId).toBe(0);
    });

    it('forgets requests when disconnected', function () {
        localPlugin._pendingThreads.set('1', 0);
        localPlugin._pendingOlderThreads.set('3', 0);
        localPlugin._listArriving = true;

        localPlugin.disconnected();

        expect(localPlugin._pendingThreads.size).toBe(0);
        expect(localPlugin._pendingOlderThreads.size).toBe(0);
        expect(localPlugin._listArriving).toBeFalse();

        testRig.setConnected(true);
    });

    it('notifies and saves once for a burst of messages', async function () {
        spyOn(localPlugin, 'notify').and.callThrough();
        spyOn(localPlugin, 'saveCache');

        phone.threads.set(4, [createMessage(4, 0)]);
        phone.threads.set(5, [createMessage(5, 0)]);
        await listConversations();

        const notifies = localPlugin.notify.calls.allArgs()
            .filter(([name]) => name === 'threads');
        const packets = localPlugin.handlePacket.calls.count();

        expect(notifies.length).toBeGreaterThan(0);
        expect(notifies.length).toBeLessThan(packets);
        expect(localPlugin.saveCache).toHaveBeenCalled();
    });

    it('still accepts a conversation list in a single packet', async function () {
        localPlugin.handlePacket({
            type: 'kdeconnect.sms.messages',
            body: {
                messages: [createMessage(6, 0), createMessage(7, 0)],
            },
        });

        await waitFor(() => localPlugin.threads['6'] && localPlugin.threads['7']);
    });

    it('can send SMS messages', async function () {
        localPlugin.sendSms('555-555-5555', 'message body');

        await remoteDevice.awaitPacket('kdeconnect.sms.request', {
            sendSms: true,
            phoneNumber: '555-555-5555',
            messageBody: 'message body',
        });
    });

    it('disables its GActions when disconnected', function () {
        testRig.setConnected(false);

        for (const action in localPlugin._meta.actions)
            expect(localPlugin.device.get_action_enabled(action)).toBeFalse();
    });
});
