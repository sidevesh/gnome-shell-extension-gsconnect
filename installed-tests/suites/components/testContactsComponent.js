// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import '../fixtures/utils.js';

import Config from '../config.js';
const {default: Store} = await import(
    `file://${Config.PACKAGE_DATADIR}/service/components/contacts.js`
);


/**
 * Find a contact the way the store did before it indexed numbers: by trying
 * every number of every contact.
 *
 * @param {object[]} contacts - The contacts
 * @param {object} query - A query, as for Store.query()
 * @returns {object|undefined} The matching contact
 */
function scanContacts(contacts, query) {
    const matches = [];

    for (const contact of contacts) {
        for (const num of contact.numbers) {
            if (query.number.equalsPhoneNumber(num.value)) {
                if (!query.name || query.name === contact.name)
                    return contact;

                matches.push(contact);
            }
        }
    }

    return matches[0];
}


describe('The contacts store', function () {
    let store;

    beforeAll(function () {
        store = new Store();

        const contacts = [
            ['Alex', ['+1 (555) 123-4567', '555-0100']],
            ['Sam', ['5551234567']],
            ['Robin', ['0044 20 7946 0958']],
            ['Short Code', ['57575']],
            ['Same Number', ['555 123 4567']],
            ['Bank', ['AX-HDFCBK']],
        ];

        for (const [name, numbers] of contacts) {
            store.add({
                id: name,
                name: name,
                numbers: numbers.map(value => ({value, type: 'cell'})),
            }, false);
        }
    });

    afterAll(function () {
        store.destroy();
    });

    it('finds the same contacts as checking every number', function () {
        const queries = [
            {number: '5551234567'},
            {number: '+15551234567'},
            {number: '1234567'},
            {number: '555-0100'},
            {number: '0100'},
            {number: '+44 20 7946 0958'},
            {number: '57575'},
            {number: '9957575'},
            {number: '5551234567', name: 'Same Number'},
            {number: 'AX-HDFCBK'},
            {number: '5559999999'},
        ];

        for (const query of queries) {
            const expected = scanContacts(store.contacts, query);
            const contact = store.query(query);

            if (expected)
                expect(contact).withContext(query.number).toBe(expected);
            else
                expect(contact.origin).withContext(query.number).toBe('gsconnect');
        }
    });

    it('updates its index when contacts change', function () {
        store.add({
            id: 'New',
            name: 'New',
            numbers: [{value: '555-999-9999', type: 'cell'}],
        }, false);

        expect(store.query({number: '5559999999'}).name).toBe('New');

        store.remove('New', false);

        expect(store.query({number: '5559999999'}).name).toBe('5559999999');
    });
});
