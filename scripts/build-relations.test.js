// Unit tests for scripts/build-relations.js, run with Node's built-in test
// runner (`node --test` from the repo root). Network is stubbed: no test
// here talks to MusicBrainz.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./build-relations.js');

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// A fetch stub that answers every call in order (each entry a
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

function fastCallOptions(extra) {
    let clock = 0;
    return { intervalMs: 0, sleep: async ms => { clock += ms; }, now: () => clock, ...extra };
}

const NAUTILUS_SEARCH = {
    recordings: [
        { id: 'ad060fd5-recording', score: 100, title: 'Nautilus', 'artist-credit': [{ name: 'Bob James', joinphrase: '' }] }
    ]
};

const NAUTILUS_DETAIL = {
    id: 'ad060fd5-recording',
    relations: [
        {
            type: 'samples material', 'target-type': 'recording', direction: 'backward',
            recording: { id: 'c5d60ff2-clap', title: 'Clap Your Hands', 'artist-credit': [{ name: 'A Tribe Called Quest', joinphrase: '' }] }
        },
        {
            type: 'performance', 'target-type': 'work',
            work: { id: 'work-nautilus' }
        }
    ]
};

const NAUTILUS_WORK = {
    id: 'work-nautilus',
    relations: [
        { 'target-type': 'recording', recording: { id: 'ad060fd5-recording', title: 'Nautilus', 'artist-credit': [{ name: 'Bob James', joinphrase: '' }] } },
        { 'target-type': 'recording', recording: { id: 'other-version', title: 'Nautilus (Live)', 'artist-credit': [{ name: 'Bob James', joinphrase: '' }] } }
    ]
};

// ---------------- keys ----------------

test('relationKeys: dedupes by artist|title, skips blanks and station legal IDs', () => {
    const keys = R.relationKeys([
        { title: 'Nautilus', artist: 'Bob James' },
        { title: 'NAUTILUS', artist: 'bob james' },       // same key
        { title: '', artist: 'Nobody' },                  // no title
        { title: 'Untitled', artist: '' },                // no artist
        { title: 'Legal ID Hannah Music', artist: 'Hannah' }   // station ID
    ]);
    assert.deepEqual([...keys.keys()], ['bob james|nautilus']);
    assert.deepEqual(keys.get('bob james|nautilus'), { artist: 'Bob James', title: 'Nautilus', playCount: 2 });
    assert.deepEqual(R.relationKeys(null).size, 0);
});

test('relationKeys: playCount tallies every play of a unique track, not just its first', () => {
    const keys = R.relationKeys([
        { title: 'Fresh', artist: 'Quakers' },
        { title: 'Fresh', artist: 'Quakers' },
        { title: 'Fresh', artist: 'Quakers' },
        { title: 'Circles', artist: 'DJ Day' }
    ]);
    assert.equal(keys.get('quakers|fresh').playCount, 3);
    assert.equal(keys.get('dj day|circles').playCount, 1);
});

// ---------------- URL builders ----------------

test('mbSearchUrl: quotes and escapes artist/title into a Lucene query', () => {
    const url = R.mbSearchUrl({ artist: 'Art "Blakey"', title: 'A Night' });
    assert.ok(url.startsWith('https://musicbrainz.org/ws/2/recording?query='));
    const q = decodeURIComponent(url.split('query=')[1].split('&')[0]);
    assert.equal(q, 'artist:"Art \\"Blakey\\"" AND recording:"A Night"');
});

test('mbRecordingUrl/mbWorkUrl: include the relationship + artist-credit incs', () => {
    assert.equal(R.mbRecordingUrl('abc'), 'https://musicbrainz.org/ws/2/recording/abc?inc=recording-rels+work-rels+artist-credits&fmt=json');
    assert.equal(R.mbWorkUrl('xyz'), 'https://musicbrainz.org/ws/2/work/xyz?inc=recording-rels+artist-credits&fmt=json');
});

// ---------------- matching ----------------

test('creditName: joins artist-credit parts by their own joinphrase', () => {
    assert.equal(R.creditName([{ name: 'Bob James', joinphrase: '' }]), 'Bob James');
    assert.equal(R.creditName([{ name: 'A', joinphrase: ' feat. ' }, { name: 'B', joinphrase: '' }]), 'A feat. B');
    assert.equal(R.creditName(null), '');
});

test('pickBestMatch: requires both a high score and a matching artist name', () => {
    const meta = { artist: 'Bob James', title: 'Nautilus' };
    assert.equal(R.pickBestMatch(NAUTILUS_SEARCH, meta, 90).id, 'ad060fd5-recording');
    assert.equal(R.pickBestMatch({ recordings: [{ id: 'x', score: 50, title: 'Nautilus', 'artist-credit': [{ name: 'Bob James' }] }] }, meta, 90), null, 'low score rejected');
    assert.equal(R.pickBestMatch({ recordings: [{ id: 'x', score: 100, title: 'Nautilus', 'artist-credit': [{ name: 'Someone Else' }] }] }, meta, 90), null, 'wrong artist rejected');
    assert.equal(R.pickBestMatch(null, meta, 90), null);
});

// ---------------- relation parsing ----------------

test('parseRecordingRelations: direction "backward" is sampledBy, "forward" is samples, notes the work id', () => {
    const { samples, sampledBy, workId } = R.parseRecordingRelations(NAUTILUS_DETAIL);
    assert.deepEqual(samples, []);
    assert.deepEqual(sampledBy, [{ artist: 'A Tribe Called Quest', title: 'Clap Your Hands', mbid: 'c5d60ff2-clap' }]);
    assert.equal(workId, 'work-nautilus');
});

test('parseRecordingRelations: a forward "samples material" relation lands under samples', () => {
    const data = { relations: [{ type: 'samples material', 'target-type': 'recording', direction: 'forward', recording: { id: 'x', title: 'Y', 'artist-credit': [{ name: 'Z', joinphrase: '' }] } }] };
    const { samples, sampledBy } = R.parseRecordingRelations(data);
    assert.deepEqual(samples, [{ artist: 'Z', title: 'Y', mbid: 'x' }]);
    assert.deepEqual(sampledBy, []);
});

test('parseRecordingRelations: no relations at all is empty, not a crash', () => {
    assert.deepEqual(R.parseRecordingRelations({}), { samples: [], sampledBy: [], workId: null });
    assert.deepEqual(R.parseRecordingRelations(null), { samples: [], sampledBy: [], workId: null });
});

test('parseWorkRecordings: every sibling recording except the track itself', () => {
    const versions = R.parseWorkRecordings(NAUTILUS_WORK, 'ad060fd5-recording');
    assert.deepEqual(versions, [{ artist: 'Bob James', title: 'Nautilus (Live)', mbid: 'other-version' }]);
});

test('parseWorkRecordings: dedupes near-duplicate MusicBrainz recordings by artist+title, not mbid', () => {
    const data = {
        relations: [
            { 'target-type': 'recording', recording: { id: 'a', title: 'Nautilus', 'artist-credit': [{ name: 'Bob James', joinphrase: '' }] } },
            { 'target-type': 'recording', recording: { id: 'b', title: 'NAUTILUS', 'artist-credit': [{ name: 'bob james', joinphrase: '' }] } },
            { 'target-type': 'recording', recording: { id: 'c', title: 'Nautilus (Live)', 'artist-credit': [{ name: 'Bob James', joinphrase: '' }] } }
        ]
    };
    const versions = R.parseWorkRecordings(data, 'self');
    assert.deepEqual(versions, [
        { artist: 'Bob James', title: 'Nautilus', mbid: 'a' },
        { artist: 'Bob James', title: 'Nautilus (Live)', mbid: 'c' }
    ]);
});

// ---------------- throttled call ----------------

test('makeThrottledCall: spaces calls out by intervalMs', async () => {
    const sleeps = [];
    let clock = 0;
    const fetch = scriptedFetch([jsonResponse(200, {}), jsonResponse(200, {})]);
    const call = R.makeThrottledCall({ fetch, intervalMs: 300, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
    await call('https://x/1');
    await call('https://x/2');
    assert.deepEqual(sleeps, [300]);
});

test('makeThrottledCall: retries 503/429/5xx with doubling backoff, then succeeds', async () => {
    const fetch = scriptedFetch([jsonResponse(503, {}), jsonResponse(429, {}), jsonResponse(200, { ok: true })]);
    const logs = [];
    const call = R.makeThrottledCall(fastCallOptions({ fetch, backoffMs: 2000, log: m => logs.push(m) }));
    const r = await call('https://x');
    assert.deepEqual(r.data, { ok: true });
    assert.equal(call.stats.retries, 2);
    assert.match(logs[0], /503/);
});

test('makeThrottledCall: an ordinary 4xx is skipped, not retried', async () => {
    const fetch = scriptedFetch([jsonResponse(404, {})]);
    const call = R.makeThrottledCall(fastCallOptions({ fetch }));
    const r = await call('https://x');
    assert.match(r.skipped, /404/);
    assert.equal(call.stats.retries, 0);
});

test('makeThrottledCall: gives up after maxAttempts and refuses every later call', async () => {
    const fetch = scriptedFetch([jsonResponse(503, {}), jsonResponse(503, {}), jsonResponse(503, {})]);
    const call = R.makeThrottledCall(fastCallOptions({ fetch, maxAttempts: 3 }));
    await assert.rejects(() => call('https://x'), R.LookupUnavailable);
    await assert.rejects(() => call('https://y'), R.LookupUnavailable);
    assert.equal(fetch.calls.length, 3, 'no further network calls once unavailable');
});

test('makeThrottledCall: sends a descriptive User-Agent', async () => {
    let headers;
    const fetch = async (url, init) => { headers = init.headers; return jsonResponse(200, {}); };
    const call = R.makeThrottledCall(fastCallOptions({ fetch }));
    await call('https://x');
    assert.match(headers['User-Agent'], /pge@teedlo\.com/);
});

// ---------------- resolveTrack ----------------

test('resolveTrack: a full match returns samples, sampledBy and otherVersions in one flow', async () => {
    const fetch = scriptedFetch([jsonResponse(200, NAUTILUS_SEARCH), jsonResponse(200, NAUTILUS_DETAIL), jsonResponse(200, NAUTILUS_WORK)]);
    const call = R.makeThrottledCall(fastCallOptions({ fetch }));
    const { entry } = await R.resolveTrack({ artist: 'Bob James', title: 'Nautilus' }, call);
    assert.equal(entry.mbid, 'ad060fd5-recording');
    assert.equal(entry.sampledBy.length, 1);
    assert.equal(entry.otherVersions.length, 1);
    assert.equal(fetch.calls.length, 3);
});

test('resolveTrack: no confident match is a confirmed empty entry, not a skip', async () => {
    const fetch = scriptedFetch([jsonResponse(200, { recordings: [] })]);
    const call = R.makeThrottledCall(fastCallOptions({ fetch }));
    const { entry } = await R.resolveTrack({ artist: 'Nobody', title: 'Nothing' }, call);
    assert.deepEqual(entry, { mbid: null, samples: [], sampledBy: [], workId: null, otherVersions: [] });
    assert.equal(fetch.calls.length, 1, 'only the search call is spent');
});

test('resolveTrack: no work relation skips the work call entirely', async () => {
    const detailNoWork = { relations: [] };
    const fetch = scriptedFetch([jsonResponse(200, NAUTILUS_SEARCH), jsonResponse(200, detailNoWork)]);
    const call = R.makeThrottledCall(fastCallOptions({ fetch }));
    const { entry } = await R.resolveTrack({ artist: 'Bob James', title: 'Nautilus' }, call);
    assert.equal(entry.workId, null);
    assert.equal(fetch.calls.length, 2);
});

test('resolveTrack: an ordinary skip on the search call is left unresolved, not recorded', async () => {
    const fetch = scriptedFetch([jsonResponse(400, {})]);
    const call = R.makeThrottledCall(fastCallOptions({ fetch }));
    const r = await R.resolveTrack({ artist: 'A', title: 'B' }, call);
    assert.match(r.skipped, /400/);
});

// ---------------- files ----------------

test('serializeRelationsFile: sorted, one track per line, deterministic', () => {
    const tracks = {
        'z|z': { mbid: null, samples: [], sampledBy: [], workId: null, otherVersions: [] },
        'a|a': { mbid: 'x', samples: [], sampledBy: [{ artist: 'B', title: 'C', mbid: 'y' }], workId: null, otherVersions: [] }
    };
    const text = R.serializeRelationsFile(tracks);
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed.tracks), ['a|a', 'z|z']);
    assert.deepEqual(parsed.tracks['a|a'], tracks['a|a']);
    const lines = text.split('\n');
    assert.ok(lines.some(l => l.startsWith('    "a|a": {')), 'each track on its own line');
    assert.equal(R.serializeRelationsFile(tracks), text, 'deterministic');
});

test('loadKnown: reads an existing relations.json, empty object when missing or malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relations-'));
    const file = path.join(dir, 'relations.json');
    fs.writeFileSync(file, JSON.stringify({ tracks: { 'a|a': { mbid: 'x', samples: [], sampledBy: [], workId: null, otherVersions: [] } } }));
    assert.deepEqual(R.loadKnown(file), { 'a|a': { mbid: 'x', samples: [], sampledBy: [], workId: null, otherVersions: [] } });
    assert.deepEqual(R.loadKnown(path.join(dir, 'missing.json')), {});
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json');
    assert.deepEqual(R.loadKnown(path.join(dir, 'bad.json')), {});
});

test('parseArgs: rejects unknown flags and bad values', () => {
    assert.throws(() => R.parseArgs(['--nope']), /Unknown option/);
    assert.throws(() => R.parseArgs(['--max-lookups', 'many']), /needs a number/);
    assert.equal(R.parseArgs(['--interval-ms', '50', '--dry-run']).intervalMs, 50);
    assert.equal(R.parseArgs(['--dry-run']).dryRun, true);
    assert.equal(R.parseArgs(['--source', 'x.json', '--out', 'y.json']).source, 'x.json');
    assert.equal(R.parseArgs(['--time-budget-ms', '90000']).timeBudgetMs, 90000);
});
