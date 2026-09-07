// Unit tests for scripts/build-enrich.js, run with Node's built-in test
// runner (`node --test` from the repo root). Network is stubbed: no test
// here talks to KMHD or iTunes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('./build-enrich.js');

const ITUNES_HIT = {
    resultCount: 1,
    results: [{
        artistName: 'Art Farmer & Jim Hall', collectionName: 'Big Blues', trackName: 'Big Blues',
        artworkUrl100: 'https://is1-ssl.mzstatic.com/x/100x100bb.jpg',
        previewUrl: 'https://audio-ssl.itunes.apple.com/x.m4a',
        trackViewUrl: 'https://music.apple.com/us/album/big-blues/1?i=2&uo=4',
        artistViewUrl: 'https://music.apple.com/us/artist/art-farmer/3?uo=4',
        collectionViewUrl: 'https://music.apple.com/us/album/big-blues/1?i=2&uo=4',
        primaryGenreName: 'Jazz', releaseDate: '1978-08-21T12:00:00Z'
    }]
};

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// A fetch stub that answers every call from `script` in order (each entry a
// Response-like object or an Error to throw) and records the URLs it saw.
function scriptedFetch(script) {
    const calls = [];
    const fn = async url => {
        calls.push(url);
        const next = script.shift();
        if (next instanceof Error) throw next;
        if (!next) throw new Error('unexpected fetch: ' + url);
        return next;
    };
    fn.calls = calls;
    return fn;
}

// Lookup options that make retries instant and deterministic.
function fastLookupOptions(extra) {
    let clock = 0;
    return {
        intervalMs: 0,
        sleep: async ms => { clock += ms; },
        now: () => clock,
        ...extra
    };
}

// ---------------- dates ----------------

test('pacificToday: is the Portland calendar date, not the UTC one', () => {
    // 03:30 UTC on the 6th is still 20:30 on the 5th in Portland (PDT).
    assert.equal(B.pacificToday(new Date('2026-09-06T03:30:00Z')), '2026-09-05');
    assert.equal(B.pacificToday(new Date('2026-09-06T12:00:00Z')), '2026-09-06');
});

test('recentDates: most recent first, today included, across a month boundary', () => {
    assert.deepEqual(B.recentDates(3, '2026-09-01'), ['2026-09-01', '2026-08-31', '2026-08-30']);
});

test('dateRange: inclusive, most recent first, empty when reversed or malformed', () => {
    assert.deepEqual(B.dateRange('2026-08-30', '2026-09-01'), ['2026-09-01', '2026-08-31', '2026-08-30']);
    assert.deepEqual(B.dateRange('2026-09-01', '2026-08-30'), []);
    assert.deepEqual(B.dateRange('nope', '2026-08-30'), []);
});

test('resolveDates: defaults to today and yesterday', () => {
    assert.deepEqual(B.resolveDates(B.parseArgs([]), '2026-09-06'), ['2026-09-06', '2026-09-05']);
});

test('resolveDates: merges every selector, dedupes, newest first', () => {
    const opts = B.parseArgs(['--dates', '2026-09-01,2026-09-06,bogus', '--weekday', '5', '--weeks', '2', '--days', '1']);
    assert.deepEqual(B.resolveDates(opts, '2026-09-06'), ['2026-09-06', '2026-09-04', '2026-09-01', '2026-08-28']);
});

test('resolveDates: --weekday with a range keeps only that weekday of the range', () => {
    const opts = B.parseArgs(['--from', '2026-08-01', '--to', '2026-08-31', '--weekday', '5']);
    assert.deepEqual(B.resolveDates(opts, '2026-09-06'), ['2026-08-28', '2026-08-21', '2026-08-14', '2026-08-07']);
});

test('parseArgs: rejects unknown flags and bad values instead of silently ignoring them', () => {
    assert.throws(() => B.parseArgs(['--nope']), /Unknown option/);
    assert.throws(() => B.parseArgs(['--days', 'many']), /needs a number/);
    assert.throws(() => B.parseArgs(['--from', '9/1/2026']), /YYYY-MM-DD/);
    assert.throws(() => B.parseArgs(['--weekday', '7']), /weekday/);
    assert.equal(B.parseArgs(['--interval-ms', '50', '--dry-run']).intervalMs, 50);
    assert.equal(B.parseArgs(['--dry-run']).dryRun, true);
});

// ---------------- keys ----------------

test('playlistKeys: one lookup per unique artist|title, first occurrence wins, blanks skipped', () => {
    const keys = B.playlistKeys([
        { title: 'Big Blues', artist: ['Art Farmer'] },
        { title: 'BIG BLUES', artist: ['art farmer'] },       // same key
        { title: '', artist: ['Nobody'] },                    // no title
        { title: 'Untitled', artist: [] },                    // no artist
        { trackName: 'Anabell', artistName: 'Mk.gee' }        // old schema
    ]);
    assert.deepEqual([...keys.keys()], ['art farmer|big blues', 'mk.gee|anabell']);
    assert.deepEqual(keys.get('art farmer|big blues'), { artist: 'Art Farmer', title: 'Big Blues' });
    assert.deepEqual(B.playlistKeys(null).size, 0);
});

test('normalizeItunesResult: keeps exactly FIELDS (no previewUrl), null when iTunes has nothing', () => {
    const entry = B.normalizeItunesResult(ITUNES_HIT);
    assert.deepEqual(Object.keys(entry), B.FIELDS);
    assert.equal(entry.trackViewUrl, 'https://music.apple.com/us/album/big-blues/1?i=2&uo=4');
    assert.equal('previewUrl' in entry, false);
    assert.equal(B.normalizeItunesResult({ resultCount: 0, results: [] }), null);
    assert.equal(B.normalizeItunesResult(null), null);
});

test('itunesUrl: sends the same "artist title" term the pages use', () => {
    const url = B.itunesUrl({ artist: 'Art Farmer', title: 'Big Blues' });
    assert.ok(url.startsWith('https://itunes.apple.com/search?'));
    assert.ok(url.includes('term=Art%20Farmer%20Big%20Blues'));
    assert.ok(url.includes('limit=1'));
});

// ---------------- throttled lookup ----------------

test('lookup: a hit becomes an entry, zero results becomes null', async () => {
    const fetch = scriptedFetch([jsonResponse(200, ITUNES_HIT), jsonResponse(200, { resultCount: 0, results: [] })]);
    const lookup = B.makeThrottledLookup(fastLookupOptions({ fetch }));
    const a = await lookup({ artist: 'Art Farmer', title: 'Big Blues' });
    const b = await lookup({ artist: 'Nobody', title: 'Nothing' });
    assert.equal(a.entry.primaryGenreName, 'Jazz');
    assert.equal(b.entry, null);
    assert.deepEqual(lookup.stats, { calls: 2, retries: 0, hits: 1, misses: 1 });
});

test('lookup: spaces calls out by intervalMs', async () => {
    let clock = 0;
    const sleeps = [];
    const fetch = scriptedFetch([jsonResponse(200, ITUNES_HIT), jsonResponse(200, ITUNES_HIT)]);
    const lookup = B.makeThrottledLookup({ fetch, intervalMs: 300, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
    await lookup({ artist: 'A', title: 'B' });
    await lookup({ artist: 'C', title: 'D' });
    assert.deepEqual(sleeps, [300]);
});

test('lookup: retries rate limits and server errors with doubling backoff, then succeeds', async () => {
    const fetch = scriptedFetch([jsonResponse(429, {}), jsonResponse(503, {}), new Error('socket hang up'), jsonResponse(200, ITUNES_HIT)]);
    const logs = [];
    const sleeps = [];
    let clock = 0;
    const lookup = B.makeThrottledLookup({ fetch, intervalMs: 0, backoffMs: 2000, log: m => logs.push(m), now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
    const r = await lookup({ artist: 'A', title: 'B' });
    assert.equal(r.entry.primaryGenreName, 'Jazz');
    assert.equal(lookup.stats.retries, 3);
    assert.equal(logs.length, 3);
    assert.match(logs[0], /429/);
    assert.deepEqual(sleeps, [2000, 4000, 8000]);
});

test('lookup: defaults ride out a multi-minute 403 penalty before giving up', async () => {
    const script = [];
    for (let i = 0; i < 7; i++) script.push(jsonResponse(403, {}));
    script.push(jsonResponse(200, ITUNES_HIT));
    let clock = 0;
    const lookup = B.makeThrottledLookup({ fetch: scriptedFetch(script), now: () => clock, sleep: async ms => { clock += ms; } });
    const r = await lookup({ artist: 'A', title: 'B' });
    assert.equal(r.entry.primaryGenreName, 'Jazz');
    assert.ok(clock >= 4 * 60 * 1000, `waited ${clock}ms in all; expected several minutes`);
});

test('lookup: gives up after maxAttempts and refuses every later call', async () => {
    const fetch = scriptedFetch([jsonResponse(403, {}), jsonResponse(403, {}), jsonResponse(403, {})]);
    const lookup = B.makeThrottledLookup(fastLookupOptions({ fetch, maxAttempts: 3 }));
    await assert.rejects(() => lookup({ artist: 'A', title: 'B' }), B.LookupUnavailable);
    assert.equal(lookup.isUnavailable(), true);
    await assert.rejects(() => lookup({ artist: 'C', title: 'D' }), B.LookupUnavailable);
    assert.equal(fetch.calls.length, 3, 'no further network calls once unavailable');
});

test('lookup: an ordinary 4xx is skipped, not retried and not recorded as a no-match', async () => {
    const fetch = scriptedFetch([jsonResponse(400, {})]);
    const lookup = B.makeThrottledLookup(fastLookupOptions({ fetch }));
    const r = await lookup({ artist: 'A', title: 'B' });
    assert.match(r.skipped, /400/);
    assert.equal(lookup.stats.retries, 0);
});

// ---------------- playlist fetch ----------------

test('fetchPlaylist: uses KMHD, falls back to the Worker, returns null when both fail', async () => {
    const day = [{ title: 'x', artist: ['y'] }];
    const ok = await B.fetchPlaylist('2026-09-05', { fetch: scriptedFetch([jsonResponse(200, day)]), sleep: async () => {} });
    assert.deepEqual(ok, day);

    const fallback = scriptedFetch([jsonResponse(500, {}), new Error('timeout'), jsonResponse(200, day)]);
    assert.deepEqual(await B.fetchPlaylist('2026-09-05', { fetch: fallback, sleep: async () => {} }), day);
    assert.ok(fallback.calls[0].includes('kmhd.org'));
    assert.ok(fallback.calls[2].includes('workers.dev'));

    const dead = scriptedFetch([jsonResponse(500, {}), jsonResponse(500, {}), jsonResponse(200, { not: 'an array' }), new Error('x')]);
    assert.equal(await B.fetchPlaylist('2026-09-05', { fetch: dead, sleep: async () => {} }), null);
});

// ---------------- building a day ----------------

test('buildDay: reuses known tracks, looks up new ones, records no-matches as null', async () => {
    const known = new Map([['art farmer|big blues', { trackViewUrl: 'known' }]]);
    const lookup = async meta => meta.title === 'Nothing' ? { entry: null } : { entry: { trackViewUrl: 'new:' + meta.title } };
    const items = [
        { title: 'Big Blues', artist: ['Art Farmer'] },
        { title: 'Big Blues', artist: ['Art Farmer'] },
        { title: 'Naima', artist: ['John Coltrane'] },
        { title: 'Nothing', artist: ['Nobody'] }
    ];
    const day = await B.buildDay('2026-09-05', items, known, lookup);
    assert.deepEqual(day.tracks, {
        'art farmer|big blues': { trackViewUrl: 'known' },
        'john coltrane|naima': { trackViewUrl: 'new:Naima' },
        'nobody|nothing': null
    });
    assert.deepEqual(day.stats, { plays: 4, unique: 3, known: 1, lookedUp: 2, matched: 1, unmatched: 1, skipped: 0, unresolved: 0 });
    assert.equal(known.get('nobody|nothing'), null, 'new results feed later dates in the same run');
    assert.equal(day.stopped, false);
});

test('buildDay: a lookup budget leaves the rest out (not null) for the next run', async () => {
    const lookup = async () => ({ entry: { trackViewUrl: 'x' } });
    const items = [{ title: 'A', artist: ['a'] }, { title: 'B', artist: ['b'] }, { title: 'C', artist: ['c'] }];
    const day = await B.buildDay('2026-09-05', items, new Map(), lookup, { budget: 1 });
    assert.deepEqual(Object.keys(day.tracks), ['a|a']);
    assert.equal(day.stats.unresolved, 2);
});

test('buildDay: stops cleanly when iTunes becomes unavailable mid-day', async () => {
    let n = 0;
    const lookup = async () => {
        if (++n === 1) return { entry: { trackViewUrl: 'x' } };
        throw new B.LookupUnavailable('down');
    };
    const items = [{ title: 'A', artist: ['a'] }, { title: 'B', artist: ['b'] }, { title: 'C', artist: ['c'] }];
    const day = await B.buildDay('2026-09-05', items, new Map(), lookup);
    assert.deepEqual(Object.keys(day.tracks), ['a|a']);
    assert.equal(day.stopped, true);
    assert.equal(day.stats.unresolved, 2);
    assert.equal(n, 2, 'no more lookups attempted after the failure');
});

test('buildDay: skipped lookups are left out of the file', async () => {
    const lookup = async () => ({ skipped: 'iTunes responded 400' });
    const day = await B.buildDay('2026-09-05', [{ title: 'A', artist: ['a'] }], new Map(), lookup);
    assert.deepEqual(day.tracks, {});
    assert.equal(day.stats.skipped, 1);
});

// ---------------- files ----------------

test('serializeDayFile: sorted, one track per line, compact on disk, parses back to the same data', () => {
    const { compactEntry, expandEntry } = require('../playlist-utils.js');
    const hit = B.normalizeItunesResult(ITUNES_HIT);
    const tracks = { 'z|z': null, 'a|a': hit };
    const text = B.serializeDayFile('2026-09-05', tracks, true);
    const parsed = JSON.parse(text);
    assert.equal(parsed.date, '2026-09-05');
    assert.equal(parsed.complete, true);
    assert.deepEqual(parsed.tracks, { 'z|z': null, 'a|a': compactEntry(hit) });
    assert.equal(parsed.tracks['a|a'].t, 2, 'stored as ids, not URLs');
    assert.equal(expandEntry(parsed.tracks['a|a']).primaryGenreName, 'Jazz');
    assert.deepEqual(Object.keys(parsed.tracks), ['a|a', 'z|z']);
    const lines = text.split('\n');
    assert.ok(lines.some(l => l.startsWith('    "a|a": {')), 'each track on its own line');
    assert.equal(B.serializeDayFile('2026-09-05', tracks, true), text, 'deterministic');
    assert.equal(JSON.parse(B.serializeDayFile('2026-09-05', tracks, false)).complete, false);
});

test('backfillDates: the days before today with no file or an incomplete one, newest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-'));
    fs.writeFileSync(path.join(dir, '2026-09-05.json'), B.serializeDayFile('2026-09-05', { 'a|a': null }, true));
    fs.writeFileSync(path.join(dir, '2026-09-04.json'), B.serializeDayFile('2026-09-04', { 'a|a': null }, false));
    fs.writeFileSync(path.join(dir, '2026-09-02.json'), '{"tracks": {"a|a": null}}');   // older file, no flag: counts as complete
    assert.deepEqual(B.backfillDates(5, '2026-09-06', dir), ['2026-09-04', '2026-09-03', '2026-09-01']);
    assert.equal(B.isDayComplete('2026-09-05', dir), true);
    assert.equal(B.isDayComplete('2026-09-04', dir), false);
    assert.equal(B.isDayComplete('2026-08-01', dir), false);
});

test('loadKnown: merges every day file, preferring a real entry over a null, ignoring junk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-'));
    fs.writeFileSync(path.join(dir, '2026-09-01.json'), JSON.stringify({ tracks: { 'a|a': null, 'b|b': { trackViewUrl: 'b1' } } }));
    fs.writeFileSync(path.join(dir, '2026-09-02.json'), JSON.stringify({ tracks: { 'a|a': { trackViewUrl: 'a2' }, 'b|b': null, 'c|c': null } }));
    fs.writeFileSync(path.join(dir, 'notes.json'), '{"tracks":{"x|x":{"trackViewUrl":"ignored"}}}');
    fs.writeFileSync(path.join(dir, '2026-09-03.json'), 'not json');
    const known = B.loadKnown(dir);
    assert.deepEqual([...known.entries()].sort(), [
        ['a|a', { trackViewUrl: 'a2' }],
        ['b|b', { trackViewUrl: 'b1' }],
        ['c|c', null]
    ]);
    assert.equal(B.loadKnown(path.join(dir, 'missing')).size, 0);
});
