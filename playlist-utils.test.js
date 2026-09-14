// Unit tests for playlist-utils.js, run with Node's built-in test runner:
//   node --test
// No dependencies required.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    trackStartDate, mapItemFields, cacheKey, normalizeArtistKey, trackYear, searchLinks,
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

test('normalizeArtistKey: case-insensitive', () => {
    assert.equal(normalizeArtistKey('Weather Report'), normalizeArtistKey('weather report'));
});

test('normalizeArtistKey: NFC and NFD forms of the same name collapse to one key', () => {
    // "Özer" as a precomposed ö (U+00F6, NFC) vs. a plain o + combining
    // diaeresis (U+006F U+0308, NFD) — visually identical, but !== as plain
    // strings, and a bare .toLowerCase() does not collapse them either.
    // This is not a hypothetical: the live enrich/ data has "Zerrin Özer"
    // stored in both forms across two different day files.
    const nfc = 'Zerrin Özer';
    const nfd = 'Zerrin Özer';
    assert.notEqual(nfc, nfd, 'sanity check: the two raw strings really do differ');
    assert.equal(normalizeArtistKey(nfc), normalizeArtistKey(nfd));
});

test('normalizeArtistKey: empty/missing input is safe', () => {
    assert.equal(normalizeArtistKey(''), '');
    assert.equal(normalizeArtistKey(null), '');
    assert.equal(normalizeArtistKey(undefined), '');
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
    // KMHD's own feed has sent this exact placeholder-looking date for a
    // track whose real release year is 1977 (per its own iTunes collection
    // ID) — nothing KMHD plays predates the 1920s.
    assert.equal(trackYear({ releaseDate: '1905-01-01' }), null);
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
// A show's slot ("Headnod: Friday 18:00-20:00") is a fixed broadcast-
// schedule concept tied to the station's own (Portland) clock, not to
// whoever happens to be running the code — so trackInSlot reads the
// hour/minute straight off `start.local`'s string, never through a Date's
// .getHours()/.getMinutes() (which convert to the CALLING environment's
// timezone). An earlier version of trackInSlot did go through Date, and an
// earlier version of this fixture worked around the resulting flakiness by
// baking the requested local hour into a UTC string built from the *test
// runner's own* local timezone — which happened to make the tests pass
// everywhere, but only because it never actually exercised a mismatch
// between the runner's timezone and the track's real (Portland) one. Build
// `start.local` directly instead, so these tests reflect what the function
// actually reads.
function itemAtLocalTime(hours, minutes) {
    const pad = n => String(n).padStart(2, '0');
    return { start: { local: `2026-08-14T${pad(hours)}:${pad(minutes)}:00-07:00` } };
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

test('trackInSlot: result does not depend on the calling process\'s own timezone', () => {
    // The regression this guards: an earlier version read the hour via
    // Date.getHours(), which converts to whatever timezone the runtime is
    // set to. On a UTC CI runner (or a non-Pacific browser), a real
    // 18:05-Portland track would be read back as 01:05 the next day and
    // fail every slot check — silently producing zero matches for every
    // show. A Friday-night track's UTC instant genuinely lands on Saturday,
    // so this also guards against a fix that swaps in trackDate()'s UTC
    // field instead of local.
    const item = itemAtLocalTime(19, 5);   // 7:05pm Portland time
    const slot = { start: '18:00', end: '20:00' };
    const original = process.env.TZ;
    try {
        process.env.TZ = 'UTC';
        assert.equal(trackInSlot(item, slot), true);
        process.env.TZ = 'Europe/Berlin';
        assert.equal(trackInSlot(item, slot), true);
    } finally {
        if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
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

test('isStationLegalId: matches station break titles, not real songs like "Illegal"', () => {
    const { isStationLegalId } = require('./playlist-utils.js');
    assert.equal(isStationLegalId('Legal ID Hannah Music'), true);
    assert.equal(isStationLegalId('40th LEGAL Bri Benson'), true);
    assert.equal(isStationLegalId('40th_LEGAL_MF'), true);
    assert.equal(isStationLegalId('Illegal'), false);
    assert.equal(isStationLegalId('Fresh'), false);
    assert.equal(isStationLegalId(''), false);
    assert.equal(isStationLegalId(undefined), false);
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
