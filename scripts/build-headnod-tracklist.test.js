// Unit tests for scripts/build-headnod-tracklist.js, run with Node's built-in
// test runner (`node --test` from the repo root). Network-free: nothing here
// talks to KMHD, iTunes, or the Worker cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('./build-headnod-tracklist.js');

function tmpFile(name) {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'headnod-tracklist-test-')), name);
}

function item(local, title, artist, extra) {
    // 2026-08-14 is a Friday.
    return { start: { local: `2026-08-14T${local}:00-07:00` }, title, artist, ...extra };
}

const SLOT = { start: '18:00', end: '20:00' };

// ---------------- known Fridays ----------------

test('newestFinishedFriday: on a Friday before 8pm Pacific, the show that day has not finished yet', () => {
    // 2026-08-14 18:30 Pacific = 2026-08-15 01:30 UTC.
    const now = new Date('2026-08-15T01:30:00Z');
    assert.equal(B.newestFinishedFriday(now), '2026-08-07');
});

test('newestFinishedFriday: on a Friday after 8pm Pacific, that day counts as finished', () => {
    // 2026-08-14 20:30 Pacific = 2026-08-15 03:30 UTC.
    const now = new Date('2026-08-15T03:30:00Z');
    assert.equal(B.newestFinishedFriday(now), '2026-08-14');
});

test('newestFinishedFriday: on any other day, the most recent past Friday', () => {
    // 2026-08-16 is a Sunday.
    const now = new Date('2026-08-16T18:00:00Z');
    assert.equal(B.newestFinishedFriday(now), '2026-08-14');
});

test('allKnownFridays: every Friday from HEADNOD_KNOWN_START through the newest, oldest first', () => {
    const now = new Date('2026-06-20T18:00:00Z');   // a Saturday
    const dates = B.allKnownFridays(now);
    assert.equal(dates[0], '2022-06-03', 'starts at HEADNOD_KNOWN_START');
    assert.equal(dates[dates.length - 1], '2026-06-19', 'ends at the newest finished Friday');
    // Compare via UTC-based dates (not local midnight, which is 25 hours
    // apart across a DST fall-back — this range spans several) so the gap
    // check reflects calendar days, not wall-clock time on this machine.
    const utcMillis = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    dates.forEach((d, i) => {
        assert.equal(new Date(d + 'T00:00:00').getDay(), 5);
        if (i > 0) assert.equal((utcMillis(d) - utcMillis(dates[i - 1])) / 86400000, 7);
    });
});

// ---------------- buildRecord ----------------

test('buildRecord: carries start/_start_time, releaseDate and artworkUrl through only when present', () => {
    const withStart = B.buildRecord({ start: { utc: 'x', local: 'y' }, title: 'T', artist: 'A', album: 'Alb' }, '2026-08-14');
    assert.deepEqual(withStart.start, { utc: 'x', local: 'y' });
    assert.ok(!('_start_time' in withStart));
    assert.ok(!('releaseDate' in withStart), 'not present when the source item has none');
    assert.ok(!('artworkUrl' in withStart));

    const oldSchema = B.buildRecord({ _start_time: 'z', title: 'T', artist: 'A', album: '' }, '2026-08-14');
    assert.equal(oldSchema._start_time, 'z');
    assert.ok(!('start' in oldSchema));

    const withExtras = B.buildRecord({ start: {}, title: 'T', artist: 'A', album: '', releaseDate: '1999', artworkUrl: 'https://x/y.jpg' }, '2026-08-14');
    assert.equal(withExtras.releaseDate, '1999');
    assert.equal(withExtras.artworkUrl, 'https://x/y.jpg');
});

test('buildRecord: merges a compact enrich entry onto the record, and skips it when there is none', () => {
    const enrich = { t: 1, c: 2, r: 3, g: 'Jazz', y: 1978 };
    const merged = B.buildRecord({ start: {}, title: 'T', artist: 'A', album: '' }, '2026-08-14', enrich);
    assert.equal(merged.t, 1);
    assert.equal(merged.g, 'Jazz');

    const noMatch = B.buildRecord({ start: {}, title: 'T', artist: 'A', album: '' }, '2026-08-14', null);
    assert.ok(!('t' in noMatch), 'a confirmed no-match (null) adds nothing');

    const neverLookedUp = B.buildRecord({ start: {}, title: 'T', artist: 'A', album: '' }, '2026-08-14', undefined);
    assert.ok(!('t' in neverLookedUp));
});

// ---------------- buildFridayTracks ----------------

test('buildFridayTracks: keeps only tracks inside the slot, sorted by air time', () => {
    const items = [
        item('19:30', 'Second', 'Artist B'),
        item('17:59', 'Too Early', 'Nope'),
        item('18:05', 'First', 'Artist A'),
        item('20:00', 'Too Late', 'Nope'),   // end is exclusive
    ];
    const tracks = B.buildFridayTracks('2026-08-14', items, SLOT, new Map());
    assert.deepEqual(tracks.map(t => t.title), ['First', 'Second']);
    tracks.forEach(t => assert.equal(t.date, '2026-08-14'));
});

test('buildFridayTracks: looks up each track by artist|title and merges what it finds', () => {
    const items = [item('18:05', 'Big Blues', 'Art Farmer')];
    const known = new Map([['art farmer|big blues', { t: 42, g: 'Jazz' }]]);
    const tracks = B.buildFridayTracks('2026-08-14', items, SLOT, known);
    assert.equal(tracks[0].t, 42);
    assert.equal(tracks[0].g, 'Jazz');
});

test('buildFridayTracks: a track with no title or artist is kept (KMHD sometimes logs gaps) but never looked up', () => {
    const items = [item('18:05', '', '')];
    const known = new Map();   // if this were queried with the empty key it would throw on .get of a key that isn't there — it isn't, it just returns undefined, so assert no crash and no stray fields instead
    const tracks = B.buildFridayTracks('2026-08-14', items, SLOT, known);
    assert.equal(tracks.length, 1);
    assert.ok(!('t' in tracks[0]));
});

test('buildFridayTracks: an empty or missing playlist produces no tracks, not a crash', () => {
    assert.deepEqual(B.buildFridayTracks('2026-08-14', [], SLOT, new Map()), []);
    assert.deepEqual(B.buildFridayTracks('2026-08-14', null, SLOT, new Map()), []);
});

// ---------------- previous-output fallback ----------------

test('loadPreviousTracksByDate: groups a previous output file\'s tracks by date', () => {
    const file = tmpFile('prev.json');
    fs.writeFileSync(file, JSON.stringify({
        tracks: [
            { date: '2026-08-07', title: 'A' },
            { date: '2026-08-07', title: 'B' },
            { date: '2026-08-14', title: 'C' }
        ]
    }));
    const byDate = B.loadPreviousTracksByDate(file);
    assert.equal(byDate.get('2026-08-07').length, 2);
    assert.equal(byDate.get('2026-08-14').length, 1);
    assert.equal(byDate.get('2026-08-14')[0].title, 'C');
});

test('loadPreviousTracksByDate: a missing or malformed file is an empty Map, not a crash', () => {
    assert.equal(B.loadPreviousTracksByDate('/nonexistent/path.json').size, 0);
    const bad = tmpFile('bad.json');
    fs.writeFileSync(bad, 'not json');
    assert.equal(B.loadPreviousTracksByDate(bad).size, 0);
});

// ---------------- concurrency-limited mapping ----------------

test('mapWithConcurrency: results come back in input order regardless of completion order', async () => {
    const delays = [30, 10, 20];
    const results = await B.mapWithConcurrency(delays, 3, (ms, i) => new Promise(resolve => setTimeout(() => resolve(i), ms)));
    assert.deepEqual(results, [0, 1, 2]);
});

test('mapWithConcurrency: never runs more than the given number at once', async () => {
    let inFlight = 0, maxInFlight = 0;
    await B.mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight--;
    });
    assert.equal(maxInFlight, 2);
});
