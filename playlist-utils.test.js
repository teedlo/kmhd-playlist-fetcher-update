// Unit tests for playlist-utils.js, run with Node's built-in test runner:
//   node --test
// No dependencies required.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    trackStartDate, mapItemFields, cacheKey, trackYear, searchLinks,
    minutesOfDay, trackInSlot, pastWeekdayDates, toIsoDate
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

test('searchLinks: builds search URLs for youtube, tidal, ebay (vinyl and CD categories) and wikipedia', () => {
    const links = searchLinks({ artist: 'Allen Toussaint', title: 'Sweet Dreams', album: 'Connected' });
    assert.equal(links.youtube, 'https://www.youtube.com/results?search_query=Allen%20Toussaint%20Sweet%20Dreams%20live');
    assert.equal(links.tidal, 'https://listen.tidal.com/search?q=Allen%20Toussaint%20Sweet%20Dreams');
    assert.equal(links.ebayVinyl, 'https://www.ebay.com/sch/i.html?_nkw=Allen%20Toussaint%20Connected&_sacat=176985');
    assert.equal(links.ebayCd, 'https://www.ebay.com/sch/i.html?_nkw=Allen%20Toussaint%20Connected&_sacat=176984');
    assert.equal(links.wiki, 'https://en.wikipedia.org/wiki/Special:Search?search=Allen%20Toussaint');
});

test('searchLinks: returns null links when there is no artist/title/album to search for', () => {
    const links = searchLinks({});
    assert.equal(links.youtube, null);
    assert.equal(links.tidal, null);
    assert.equal(links.ebayVinyl, null);
    assert.equal(links.ebayCd, null);
    assert.equal(links.wiki, null);
});

test('searchLinks: eBay links use artist alone (no double space) when there is no album', () => {
    const links = searchLinks({ artist: 'Allen Toussaint', title: 'Sweet Dreams' });
    assert.equal(links.ebayVinyl, 'https://www.ebay.com/sch/i.html?_nkw=Allen%20Toussaint&_sacat=176985');
    assert.equal(links.ebayCd, 'https://www.ebay.com/sch/i.html?_nkw=Allen%20Toussaint&_sacat=176984');
});

test('searchLinks: eBay links still work from album alone when there is no artist', () => {
    const links = searchLinks({ album: 'Connected' });
    assert.equal(links.ebayVinyl, 'https://www.ebay.com/sch/i.html?_nkw=Connected&_sacat=176985');
    assert.equal(links.ebayCd, 'https://www.ebay.com/sch/i.html?_nkw=Connected&_sacat=176984');
});

// ---------------- "By Show" helpers ----------------
// trackInSlot deliberately compares against the *viewer's* local clock
// (d.getHours()), which is what the page wants — a slot is "6-8pm" as the
// listener sees it. That makes a hardcoded UTC-string fixture depend on
// the machine's timezone: these tests passed on CI (UTC runners) but
// failed on a Pacific laptop, where 19:05Z reads back as 12:05.
//
// So build fixtures from *local* components instead. The resulting
// instant differs by timezone, but the local hour trackInSlot reads is
// whatever we asked for, everywhere.
function itemAtLocalTime(hours, minutes) {
    const d = new Date(2026, 7, 14, hours, minutes, 0);   // 2026-08-14, local time
    return { start: { utc: d.toISOString() } };
}

test('minutesOfDay: converts HH:MM to minutes since midnight', () => {
    assert.equal(minutesOfDay('00:00'), 0);
    assert.equal(minutesOfDay('06:30'), 390);
    assert.equal(minutesOfDay('23:59'), 1439);
});

test('trackInSlot: true when the track starts inside the slot', () => {
    const item = itemAtLocalTime(19, 5);
    const slot = { start: '18:00', end: '20:00' };
    assert.equal(trackInSlot(item, slot), true);
});

test('trackInSlot: false when the track starts before or after the slot', () => {
    const before = itemAtLocalTime(17, 59);
    const after = itemAtLocalTime(20, 0);   // end is exclusive
    const slot = { start: '18:00', end: '20:00' };
    assert.equal(trackInSlot(before, slot), false);
    assert.equal(trackInSlot(after, slot), false);
});

test('trackInSlot: end "24:00" includes tracks up to (not including) midnight', () => {
    const item = itemAtLocalTime(23, 59);
    const slot = { start: '22:00', end: '24:00' };
    assert.equal(trackInSlot(item, slot), true);
});

test('trackInSlot: false for a track with no usable timestamp', () => {
    assert.equal(trackInSlot({}, { start: '18:00', end: '20:00' }), false);
    assert.equal(trackInSlot(null, { start: '18:00', end: '20:00' }), false);
});

test('toIsoDate: formats a Date as YYYY-MM-DD in local time', () => {
    assert.equal(toIsoDate(new Date(2026, 7, 14)), '2026-08-14');
    assert.equal(toIsoDate(new Date(2026, 0, 5)), '2026-01-05');    // zero-padded month and day
    assert.equal(toIsoDate(new Date(2026, 11, 31)), '2026-12-31');
});

test('toIsoDate: local midnight keeps its own date, whatever the timezone', () => {
    // The regression this guards: toISOString() would return the *previous*
    // day here for any timezone east of UTC, because local midnight is
    // still yesterday in UTC. pastWeekdayDates fed exactly this into the
    // playlist fetch, so European visitors browsed the wrong day.
    const midnight = new Date(2026, 7, 14, 0, 0, 0);
    assert.equal(toIsoDate(midnight), '2026-08-14');
    const almostMidnight = new Date(2026, 7, 14, 23, 59, 59);
    assert.equal(toIsoDate(almostMidnight), '2026-08-14');
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

// ---------------- Apple Music / per-day enrichment helpers ----------------

test('enrichKey: is "artist|title", lowercased, and what cacheKey builds on', () => {
    const { enrichKey } = require('./playlist-utils.js');
    assert.equal(enrichKey({ artist: 'Art Farmer', title: 'Big Blues' }), 'art farmer|big blues');
    assert.equal(enrichKey({}), '|');
    assert.equal(cacheKey('itunes1:', { artist: 'Art Farmer', title: 'Big Blues' }), 'itunes1:' + enrichKey({ artist: 'Art Farmer', title: 'Big Blues' }));
});

test('trackDate: reads the KMHD (Portland-local) day straight off start.local', () => {
    const { trackDate } = require('./playlist-utils.js');
    // 21:53 Portland on the 5th is already the 6th in UTC; the day file is the 5th.
    const item = { start: { utc: '2026-09-06T04:53:01Z', local: '2026-09-05T21:53:01-07:00', timezone: 'America/Los_Angeles' } };
    assert.equal(trackDate(item), '2026-09-05');
});

test('trackDate: falls back to the old schema and to nothing at all', () => {
    const { trackDate } = require('./playlist-utils.js');
    assert.equal(trackDate({ _start_time: '2023-08-03T18:57:25.000-07:00' }), '2023-08-03');
    assert.equal(trackDate({}), null);
    assert.equal(trackDate(null), null);
});

test('searchLinks: builds an Apple Music search link, the instant stand-in for the exact track link', () => {
    const links = searchLinks({ artist: 'Allen Toussaint', title: 'Sweet Dreams', album: 'Connected' });
    assert.equal(links.appleMusic, 'https://music.apple.com/us/search?term=Allen%20Toussaint%20Sweet%20Dreams');
    assert.equal(searchLinks({}).appleMusic, null);
});

// ---------------- compact enrichment entries ----------------

const VERBOSE = {
    artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music22/v4/c8/c3/57/c8c357cd/mzm.rzssgvjk.jpg/100x100bb.jpg',
    trackViewUrl: 'https://music.apple.com/us/album/big-blues/1056792206?i=1056792217&uo=4',
    artistViewUrl: 'https://music.apple.com/us/artist/art-farmer/338447?uo=4',
    collectionViewUrl: 'https://music.apple.com/us/album/big-blues/1056792206?i=1056792217&uo=4',
    collectionName: 'Big Blues', primaryGenreName: 'Jazz', releaseDate: '1978-08-21T12:00:00Z'
};

test('compactEntry: reduces an iTunes entry to ids, artwork path, genre and year', () => {
    const { compactEntry } = require('./playlist-utils.js');
    assert.deepEqual(compactEntry(VERBOSE), {
        t: 1056792217, c: 1056792206, r: 338447,
        a: 'Music22/v4/c8/c3/57/c8c357cd/mzm.rzssgvjk.jpg', h: 1, g: 'Jazz', y: 1978
    });
    assert.ok(JSON.stringify(compactEntry(VERBOSE)).length < JSON.stringify(VERBOSE).length / 2, 'well under half the size');
    assert.equal(compactEntry(null), null);
});

test('expandEntry: rebuilds working Apple Music URLs and the fields the pages read', () => {
    const { compactEntry, expandEntry } = require('./playlist-utils.js');
    const back = expandEntry(compactEntry(VERBOSE));
    assert.equal(back.trackViewUrl, 'https://music.apple.com/us/album/id1056792206?i=1056792217');
    assert.equal(back.collectionViewUrl, back.trackViewUrl);
    assert.equal(back.artistViewUrl, 'https://music.apple.com/us/artist/id338447');
    assert.equal(back.artworkUrl100, VERBOSE.artworkUrl100);
    assert.equal(back.primaryGenreName, 'Jazz');
    assert.equal(trackYear(back), 1978);
    assert.equal(expandEntry(null), null);
});

test('compactEntry/expandEntry: anything off-pattern is kept verbatim, and both are idempotent', () => {
    const { compactEntry, expandEntry } = require('./playlist-utils.js');
    const odd = { ...VERBOSE, artistViewUrl: 'https://music.apple.com/gb/artist/someone/1?x=1', artworkUrl100: 'https://example.com/art.png', collectionViewUrl: 'https://music.apple.com/us/album/other/9' };
    const c = compactEntry(odd);
    assert.equal(c.artistViewUrl, odd.artistViewUrl);
    assert.equal(c.artworkUrl100, odd.artworkUrl100);
    assert.equal(c.collectionViewUrl, odd.collectionViewUrl);
    assert.equal(c.r, undefined);
    const e = expandEntry(c);
    assert.equal(e.artistViewUrl, odd.artistViewUrl);
    assert.equal(e.collectionViewUrl, odd.collectionViewUrl);
    assert.deepEqual(compactEntry(c), c, 'compacting a compact entry changes nothing');
    assert.deepEqual(expandEntry(expandEntry(VERBOSE)), expandEntry(VERBOSE), 'expanding a verbose entry changes nothing');
    assert.deepEqual(expandEntry(e), e);
});

test('expandEntry: a verbose entry (older file, localStorage) passes through with its own URLs', () => {
    const { expandEntry } = require('./playlist-utils.js');
    const e = expandEntry(VERBOSE);
    assert.equal(e.trackViewUrl, VERBOSE.trackViewUrl);
    assert.equal(e.artistViewUrl, VERBOSE.artistViewUrl);
    assert.equal(e.releaseDate, VERBOSE.releaseDate);
});
