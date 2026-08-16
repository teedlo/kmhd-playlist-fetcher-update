// Unit tests for playlist-utils.js, run with Node's built-in test runner:
//   node --test
// No dependencies required.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    trackStartDate, mapItemFields, cacheKey, trackYear, searchLinks,
    minutesOfDay, trackInSlot, pastWeekdayDates
} = require('./playlist-utils.js');

test('trackStartDate: reads the new KMHD schema (start.utc)', () => {
    const item = {
        start: {
            utc: '2026-08-15T06:36:22Z',
            local: '2026-08-14T23:36:22-07:00',
            timezone: 'America/Los_Angeles'
        }
    };
    const d = trackStartDate(item);
    assert.ok(d instanceof Date, 'should return a Date');
    assert.equal(d.toISOString(), '2026-08-15T06:36:22.000Z');
});

test('trackStartDate: falls back to start.local when start.utc is missing', () => {
    const item = { start: { local: '2026-08-14T23:36:22-07:00' } };
    const d = trackStartDate(item);
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString(), '2026-08-15T06:36:22.000Z');
});

test('trackStartDate: falls back to the old pre-2026 schema (_start_time)', () => {
    const item = { _start_time: '2023-08-03T18:57:25.000-07:00' };
    const d = trackStartDate(item);
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString(), '2023-08-04T01:57:25.000Z');
});

test('trackStartDate: returns null when there is no usable timestamp', () => {
    assert.equal(trackStartDate({}), null);
    assert.equal(trackStartDate(null), null);
    assert.equal(trackStartDate({ start: {} }), null);
});

test('trackStartDate: returns null for an unparsable timestamp instead of an Invalid Date', () => {
    const d = trackStartDate({ _start_time: 'not-a-real-date' });
    assert.equal(d, null);
});

test('mapItemFields: reads the new schema, joining array-valued artist', () => {
    const item = { title: 'Sweet Dreams', artist: ['Allen Toussaint'], album: 'Connected' };
    assert.deepEqual(mapItemFields(item), {
        title: 'Sweet Dreams',
        artist: 'Allen Toussaint',
        album: 'Connected'
    });
});

test('mapItemFields: joins multiple artists with a comma', () => {
    const item = { title: 'Song', artist: ['A', 'B'], album: 'X' };
    assert.equal(mapItemFields(item).artist, 'A, B');
});

test('mapItemFields: falls back to the old iTunes-enriched field names', () => {
    const item = { trackName: 'Anabell', artistName: 'Mk.gee', collectionName: 'Pronounced McGee' };
    assert.deepEqual(mapItemFields(item), {
        title: 'Anabell',
        artist: 'Mk.gee',
        album: 'Pronounced McGee'
    });
});

test('mapItemFields: missing fields come back as empty strings, not undefined', () => {
    assert.deepEqual(mapItemFields({}), { title: '', artist: '', album: '' });
});

test('cacheKey: combines prefix, artist and title, lowercased', () => {
    const key = cacheKey('itunes1:', { artist: 'Allen Toussaint', title: 'Sweet Dreams' });
    assert.equal(key, 'itunes1:allen toussaint|sweet dreams');
});

test('cacheKey: is case-insensitive so differently-cased duplicates share a cache entry', () => {
    const a = cacheKey('itunes1:', { artist: 'The Beatles', title: 'Help!' });
    const b = cacheKey('itunes1:', { artist: 'the beatles', title: 'HELP!' });
    assert.equal(a, b);
});

test('trackYear: reads a 4-digit year out of releaseDate', () => {
    assert.equal(trackYear({ releaseDate: '2019-05-17' }), 2019);
    assert.equal(trackYear({ releaseDate: '1977' }), 1977);
});

test('trackYear: returns null when there is no usable release date', () => {
    assert.equal(trackYear({}), null);
    assert.equal(trackYear(null), null);
    assert.equal(trackYear({ releaseDate: 'unknown' }), null);
});

test('trackYear: rejects out-of-range years as bad data', () => {
    assert.equal(trackYear({ releaseDate: '3099-01-01' }), null);
});

test('searchLinks: builds search URLs for youtube, tidal, ebay and wikipedia', () => {
    const links = searchLinks({ artist: 'Allen Toussaint', title: 'Sweet Dreams', album: 'Connected' });
    assert.equal(links.youtube, 'https://www.youtube.com/results?search_query=Allen%20Toussaint%20Sweet%20Dreams%20live');
    assert.equal(links.tidal, 'https://listen.tidal.com/search?q=Allen%20Toussaint%20Sweet%20Dreams');
    assert.equal(links.ebayVinyl, 'https://www.ebay.com/sch/i.html?_nkw=Allen%20Toussaint%20Connected%20vinyl');
    assert.equal(links.wiki, 'https://en.wikipedia.org/wiki/Special:Search?search=Allen%20Toussaint');
});

test('searchLinks: returns null links when there is no artist/title/album to search for', () => {
    const links = searchLinks({});
    assert.equal(links.youtube, null);
    assert.equal(links.tidal, null);
    assert.equal(links.ebayVinyl, null);
    assert.equal(links.wiki, null);
});

// ---------------- "By Show" helpers ----------------
// These tests run with TZ=UTC (confirmed via Intl.DateTimeFormat in this
// environment), so an item's start.utc hour equals what trackInSlot's
// d.getHours() will read — keeping the fixtures simple and predictable.

test('minutesOfDay: converts HH:MM to minutes since midnight', () => {
    assert.equal(minutesOfDay('00:00'), 0);
    assert.equal(minutesOfDay('06:30'), 390);
    assert.equal(minutesOfDay('23:59'), 1439);
});

test('trackInSlot: true when the track starts inside the slot', () => {
    const item = { start: { utc: '2026-08-14T19:05:00Z' } };  // 19:05
    const slot = { start: '18:00', end: '20:00' };
    assert.equal(trackInSlot(item, slot), true);
});

test('trackInSlot: false when the track starts before or after the slot', () => {
    const before = { start: { utc: '2026-08-14T17:59:00Z' } };
    const after = { start: { utc: '2026-08-14T20:00:00Z' } };  // end is exclusive
    const slot = { start: '18:00', end: '20:00' };
    assert.equal(trackInSlot(before, slot), false);
    assert.equal(trackInSlot(after, slot), false);
});

test('trackInSlot: end "24:00" includes tracks up to (not including) midnight', () => {
    const item = { start: { utc: '2026-08-14T23:59:00Z' } };
    const slot = { start: '22:00', end: '24:00' };
    assert.equal(trackInSlot(item, slot), true);
});

test('trackInSlot: false for a track with no usable timestamp', () => {
    assert.equal(trackInSlot({}, { start: '18:00', end: '20:00' }), false);
    assert.equal(trackInSlot(null, { start: '18:00', end: '20:00' }), false);
});

test('pastWeekdayDates: returns the given weekday going back, most recent first', () => {
    // 2026-08-16 is a Sunday (weekday 0). Asking for Friday (5) on/before
    // that date should start at 2026-08-14, then step back a week at a time.
    const dates = pastWeekdayDates(5, 3, '2026-08-16');
    assert.deepEqual(dates, ['2026-08-14', '2026-08-07', '2026-07-31']);
});

test('pastWeekdayDates: when fromDate IS the target weekday, it is included as the first result', () => {
    // 2026-08-14 is itself a Friday.
    const dates = pastWeekdayDates(5, 2, '2026-08-14');
    assert.deepEqual(dates, ['2026-08-14', '2026-08-07']);
});

test('pastWeekdayDates: returns an empty array for an unparsable date', () => {
    assert.deepEqual(pastWeekdayDates(5, 3, 'not-a-date'), []);
});
