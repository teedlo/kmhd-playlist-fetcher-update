#!/usr/bin/env node
// scripts/build-enrich.js
//
// Precomputes the Apple Music links (plus album art and genre) for every
// track KMHD played on a given day and writes them to enrich/YYYY-MM-DD.json.
// index.html and headnod.html load that one small file next to the day's
// playlist, so every row renders with its exact Apple Music link already
// in place instead of looking tracks up in the browser one at a time
// (which, at iTunes' rate limit, took minutes per page).
//
// The enrich/ files are also this script's memory: every run reads all of
// them first and only looks up tracks it has never seen, so re-running a
// date is cheap and a track that was played before is never looked up twice.
//
// Usage:
//   node scripts/build-enrich.js                      # today + yesterday (Portland time)
//   node scripts/build-enrich.js --days 7             # the 7 most recent Portland dates, today included
//   node scripts/build-enrich.js --dates 2026-09-01,2026-09-02
//   node scripts/build-enrich.js --from 2026-06-01 --to 2026-08-31
//   node scripts/build-enrich.js --weekday 5 --weeks 52    # the last 52 Fridays (0=Sun .. 6=Sat)
//   node scripts/build-enrich.js --days 3 --backfill 120 --max-lookups 900
//       # what the scheduled workflow runs: the last 3 days, then fill in
//       # any day of the last 120 that has no file yet (or an incomplete
//       # one), newest first, until 900 lookups have been spent
//
// Options:
//   --backfill N      after the dates asked for, also build any of the N
//                     days before today whose file is missing or was left
//                     incomplete ("complete": false) by an earlier run
//   --interval-ms N   minimum gap between iTunes Search calls (default
//                     3500: about 17 a minute. iTunes allows bursts but
//                     answers 403 for minutes after a few hundred quick
//                     calls, so faster only pays off for very short runs)
//   --max-lookups N   stop looking up after N tracks this run; whatever is
//                     left is simply omitted from the file (which is then
//                     marked incomplete), so the page falls back to a live
//                     lookup for those and a later --backfill run finishes
//   --dry-run         build and report, but write nothing
//
// No dependencies; Node 18+ (global fetch). Run from anywhere: paths are
// resolved relative to this file.
//
// Failure policy: a network hiccup or an iTunes rate-limit (403/429/5xx)
// is retried with exponential backoff (2s, 4s, ... 128s: a 403 penalty
// has been seen to last a couple of minutes); if it keeps failing, the
// run stops looking things up, writes what it has, and exits 0 with a
// warning, so a bad half hour at Apple never blocks the deploy. Only a
// confirmed "0 results" answer is recorded as null (no Apple Music match);
// anything unresolved is left out of the file rather than mis-recorded.

'use strict';

const fs = require('fs');
const path = require('path');
const PlaylistUtils = require('../playlist-utils.js');

const ROOT = path.resolve(__dirname, '..');
const ENRICH_DIR = path.join(ROOT, 'enrich');

const KMHD_API = 'https://www.kmhd.org/pf/api/v3/content/fetch/playlist';
const KMHD_PROXY = 'https://kmhd-playlist-cache.teedlo.workers.dev/';
const ITUNES_SEARCH = 'https://itunes.apple.com/search';

const NOTE = 'Built by scripts/build-enrich.js: iTunes Search results for every track KMHD played this day, keyed "artist|title" (lowercased). null means iTunes found no Apple Music match. Do not edit by hand; rerun the script instead.';

// Fields kept per track. Same shape the pages' own live lookup produces,
// minus previewUrl: the 30-second preview player is disabled in both
// pages, and those URLs are the bulkiest, least compressible part of an
// entry. If the player ever comes back, add 'previewUrl' here and rebuild.
const FIELDS = ['artworkUrl100', 'trackViewUrl', 'artistViewUrl', 'collectionViewUrl',
    'collectionName', 'primaryGenreName', 'releaseDate'];

const DEFAULTS = {
    fetchTimeoutMs: 20000,   // no request may hang a run: a stalled socket is retried like any other failure
    intervalMs: 3500,
    maxLookups: Infinity,
    maxAttempts: 8,          // per lookup, with backoff 2s, 4s, ... 128s between (about 4 minutes in all)
    backoffMs: 2000,
    backfill: 0,
    dryRun: false
};

// ---------------- dates ----------------

// Today's date in Portland, as YYYY-MM-DD. KMHD's per-day API is bucketed
// by Pacific date, so "today" must be Pacific too, whatever the runner's
// clock is set to (GitHub's runners are UTC).
function pacificToday(now) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now || new Date());
}

// Adds `days` (may be negative) to a YYYY-MM-DD date. Pure calendar math
// on local-time components, so it is timezone-proof (see toIsoDate).
function addDays(iso, days) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return PlaylistUtils.toIsoDate(d);
}

// The `count` most recent dates ending at (and including) `todayIso`,
// most recent first.
function recentDates(count, todayIso) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(addDays(todayIso, -i));
    return out;
}

// Every date from `from` to `to` inclusive, most recent first.
function dateRange(from, to) {
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) return [];
    const out = [];
    for (let d = to; d >= from; d = addDays(d, -1)) out.push(d);
    return out;
}

function isIsoDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00').getTime());
}

// Which dates a parsed command line asks for, most recent first, deduped.
function resolveDates(opts, todayIso) {
    let dates = [];
    if (opts.dates) dates = dates.concat(opts.dates);
    if (opts.from || opts.to) dates = dates.concat(dateRange(opts.from, opts.to || todayIso));
    if (opts.weekday != null) dates = dates.concat(PlaylistUtils.pastWeekdayDates(opts.weekday, opts.weeks || 1, todayIso));
    if (opts.days != null || dates.length === 0) dates = dates.concat(recentDates(opts.days == null ? 2 : opts.days, todayIso));
    const seen = new Set();
    return dates
        .filter(d => isIsoDate(d) && !seen.has(d) && seen.add(d))
        .sort((a, b) => b.localeCompare(a));
}

// The dates within the `days` before `todayIso` (today itself excluded:
// it is always still being played) that have no day file yet or one an
// earlier run left incomplete. Newest first, so the most-browsed days
// fill in first when the lookup budget runs out.
function backfillDates(days, todayIso, dir) {
    const out = [];
    for (let i = 1; i <= days; i++) {
        const date = addDays(todayIso, -i);
        if (!isDayComplete(date, dir)) out.push(date);
    }
    return out;
}

// ---------------- command line ----------------

function parseArgs(argv) {
    const opts = { ...DEFAULTS };
    const args = argv.slice();
    const num = (flag) => {
        const v = Number(args.shift());
        if (!Number.isFinite(v)) throw new Error(`${flag} needs a number`);
        return v;
    };
    while (args.length) {
        const a = args.shift();
        switch (a) {
            case '--days': opts.days = num(a); break;
            case '--backfill': opts.backfill = num(a); break;
            case '--dates': opts.dates = String(args.shift() || '').split(',').map(s => s.trim()).filter(Boolean); break;
            case '--from': opts.from = args.shift(); break;
            case '--to': opts.to = args.shift(); break;
            case '--weekday': opts.weekday = num(a); break;
            case '--weeks': opts.weeks = num(a); break;
            case '--interval-ms': opts.intervalMs = num(a); break;
            case '--max-lookups': opts.maxLookups = num(a); break;
            case '--dry-run': opts.dryRun = true; break;
            case '--help': case '-h': opts.help = true; break;
            default: throw new Error(`Unknown option: ${a}`);
        }
    }
    if (opts.from && !isIsoDate(opts.from)) throw new Error('--from must be YYYY-MM-DD');
    if (opts.to && !isIsoDate(opts.to)) throw new Error('--to must be YYYY-MM-DD');
    if (opts.weekday != null && (opts.weekday < 0 || opts.weekday > 6)) throw new Error('--weekday must be 0 (Sunday) to 6 (Saturday)');
    return opts;
}

function usage() {
    return fs.readFileSync(__filename, 'utf8').split('\n')
        .slice(1).filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, ''))
        .join('\n');
}

// ---------------- playlist -> keys ----------------

// The unique "artist|title" keys in one day's playlist, each with the
// {artist, title} the lookup should use (first occurrence wins). Items
// with no title or no artist (station IDs, gaps) can't be looked up and
// are skipped, exactly as the pages skip them.
function playlistKeys(items) {
    const keys = new Map();
    (Array.isArray(items) ? items : []).forEach(item => {
        const meta = PlaylistUtils.mapItemFields(item);
        if (!meta.title || !meta.artist) return;
        const key = PlaylistUtils.enrichKey(meta);
        if (!keys.has(key)) keys.set(key, { artist: meta.artist, title: meta.title });
    });
    return keys;
}

// ---------------- iTunes ----------------

// One iTunes Search hit -> the entry stored per track (FIELDS only, each
// null when iTunes left it out). Returns null for "no results".
function normalizeItunesResult(data) {
    const r = data && Array.isArray(data.results) && data.results[0];
    if (!r) return null;
    const entry = {};
    FIELDS.forEach(f => { entry[f] = r[f] || null; });
    return entry;
}

function itunesUrl(meta) {
    // Same query the pages send from the browser, so the match is the one
    // a visitor would have got from a live lookup.
    const term = `${meta.artist} ${meta.title}`;
    return `${ITUNES_SEARCH}?media=music&entity=song&limit=1&country=US&term=${encodeURIComponent(term)}`;
}

class LookupUnavailable extends Error {}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Returns an async lookup(meta) -> entry | null that spaces calls out by
// intervalMs and retries transient failures with exponential backoff.
// When a lookup fails every attempt it throws LookupUnavailable, after
// which every later call throws immediately: iTunes is refusing us and
// the run should wind down rather than hammer it.
function makeThrottledLookup(options) {
    const opts = { ...DEFAULTS, fetch: globalThis.fetch, log: () => {}, sleep, now: Date.now, ...options };
    let nextAllowed = 0;
    let unavailable = false;
    const stats = { calls: 0, retries: 0, hits: 0, misses: 0 };

    async function attempt(meta) {
        const res = await opts.fetch(itunesUrl(meta), { signal: AbortSignal.timeout(opts.fetchTimeoutMs) });
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
            throw new Error(`iTunes responded ${res.status}`);
        }
        if (!res.ok) {
            // A 4xx that isn't rate limiting (a term iTunes won't parse,
            // say) will not get better with retries. Leave the track out
            // rather than record a no-match that may be wrong.
            return { skipped: `iTunes responded ${res.status}` };
        }
        const data = await res.json();
        return { entry: normalizeItunesResult(data) };
    }

    async function lookup(meta) {
        if (unavailable) throw new LookupUnavailable('iTunes lookups are unavailable for the rest of this run');
        for (let n = 1; ; n++) {
            const wait = nextAllowed - opts.now();
            if (wait > 0) await opts.sleep(wait);
            nextAllowed = opts.now() + opts.intervalMs;
            stats.calls++;
            try {
                const result = await attempt(meta);
                if (result.skipped) {
                    opts.log(`  skip  ${meta.artist} - ${meta.title}: ${result.skipped}`);
                    return { skipped: result.skipped };
                }
                if (result.entry) stats.hits++; else stats.misses++;
                return { entry: result.entry };
            } catch (e) {
                if (n >= opts.maxAttempts) {
                    unavailable = true;
                    throw new LookupUnavailable(`iTunes lookup failed ${n} times (${e.message}); stopping lookups for this run`);
                }
                const backoff = opts.backoffMs * Math.pow(2, n - 1);
                stats.retries++;
                opts.log(`  retry ${meta.artist} - ${meta.title}: ${e.message}; waiting ${backoff / 1000}s`);
                nextAllowed = opts.now() + backoff;
            }
        }
    }

    lookup.stats = stats;
    lookup.isUnavailable = () => unavailable;
    return lookup;
}

// ---------------- playlist fetch ----------------

async function fetchJson(fetchFn, url, timeoutMs) {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs || DEFAULTS.fetchTimeoutMs) });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return res.json();
}

// One day's playlist from KMHD, with the shared Cloudflare Worker cache
// as a fallback (it serves the same JSON; its CORS header only matters in
// browsers). Returns null if neither answers with an array.
async function fetchPlaylist(date, options) {
    const opts = { fetch: globalThis.fetch, log: () => {}, sleep, ...options };
    const urls = [
        `${KMHD_API}?query=${encodeURIComponent(JSON.stringify({ day: date }))}`,
        `${KMHD_PROXY}?day=${encodeURIComponent(date)}`
    ];
    for (const url of urls) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const data = await fetchJson(opts.fetch, url, opts.fetchTimeoutMs);
                if (Array.isArray(data)) return data;
                throw new Error('response was not a playlist array');
            } catch (e) {
                opts.log(`  playlist ${date}: ${e.message}`);
                if (attempt < 2) await opts.sleep(2000);
            }
        }
    }
    return null;
}

// ---------------- building a day ----------------

// Loads every existing enrich/*.json into one Map so nothing already
// resolved is ever looked up again. A real entry beats a null for the
// same key, whichever file it came from.
function loadKnown(dir) {
    const known = new Map();
    if (!fs.existsSync(dir)) return known;
    fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().forEach(f => {
        let data;
        try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return; }
        const tracks = data && data.tracks;
        if (!tracks || typeof tracks !== 'object') return;
        Object.keys(tracks).forEach(key => {
            if (tracks[key] || !known.has(key)) known.set(key, tracks[key]);
        });
    });
    return known;
}

// Resolves every track in `items` against `known`, looking up the rest
// (up to `budget` of them). Returns the tracks object for the day file
// plus what happened. Unresolved keys are left out, never guessed.
async function buildDay(date, items, known, lookup, options) {
    const opts = { budget: Infinity, log: () => {}, ...options };
    const keys = playlistKeys(items);
    const tracks = {};
    const stats = { plays: items.length, unique: keys.size, known: 0, lookedUp: 0, matched: 0, unmatched: 0, skipped: 0, unresolved: 0 };
    let budget = opts.budget;
    let stopped = false;

    for (const [key, meta] of keys) {
        if (known.has(key)) {
            tracks[key] = known.get(key);
            stats.known++;
            continue;
        }
        if (stopped || budget <= 0) { stats.unresolved++; continue; }
        budget--;
        let result;
        try {
            result = await lookup(meta);
        } catch (e) {
            if (!(e instanceof LookupUnavailable)) throw e;
            opts.log(`  ${e.message}`);
            stopped = true;
            stats.unresolved++;
            continue;
        }
        stats.lookedUp++;
        if (result.skipped) { stats.skipped++; continue; }
        tracks[key] = result.entry;
        known.set(key, result.entry);
        if (result.entry) stats.matched++; else stats.unmatched++;
    }
    return { date, tracks, stats, stopped };
}

// One track per line, keys sorted: small diffs when a day is rebuilt,
// and byte-identical output when nothing changed (so the scheduled
// workflow commits only real updates). "complete" is false when some of
// the day's tracks were left out (lookup budget spent, or iTunes down),
// which is what --backfill uses to know the day still needs a run.
function serializeDayFile(date, tracks, complete) {
    const keys = Object.keys(tracks).sort();
    const lines = keys.map(k => `    ${JSON.stringify(k)}: ${JSON.stringify(tracks[k])}`);
    return '{\n'
        + `  "note": ${JSON.stringify(NOTE)},\n`
        + `  "date": ${JSON.stringify(date)},\n`
        + `  "complete": ${complete !== false},\n`
        + '  "tracks": {\n'
        + lines.join(',\n') + '\n'
        + '  }\n'
        + '}\n';
}

function dayFilePath(date, dir) {
    return path.join(dir || ENRICH_DIR, `${date}.json`);
}

function readDayFile(date, dir) {
    try {
        return JSON.parse(fs.readFileSync(dayFilePath(date, dir), 'utf8'));
    } catch (e) {
        return null;
    }
}

function isDayComplete(date, dir) {
    const data = readDayFile(date, dir);
    return !!(data && data.tracks && data.complete !== false);
}

// Written via a temp file + rename so a crash mid-write can never leave a
// half-written (unparseable) file for the page or the next run to trip on.
function writeDayFile(date, tracks, complete) {
    fs.mkdirSync(ENRICH_DIR, { recursive: true });
    const file = dayFilePath(date);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, serializeDayFile(date, tracks, complete));
    fs.renameSync(tmp, file);
    return file;
}

// ---------------- main ----------------

async function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        console.error(e.message);
        console.error('Run with --help for usage.');
        return 2;
    }
    if (opts.help) { console.log(usage()); return 0; }

    const log = msg => console.log(msg);
    const today = pacificToday();
    const asked = resolveDates(opts, today);
    const gaps = opts.backfill > 0
        ? backfillDates(opts.backfill, today, ENRICH_DIR).filter(d => !asked.includes(d))
        : [];
    const dates = asked.concat(gaps);
    const known = loadKnown(ENRICH_DIR);
    log(`${asked.length} date(s) asked for, ${gaps.length} older gap(s) to fill, ${known.size} track(s) already known (Portland today: ${today})`);

    const lookup = makeThrottledLookup({ intervalMs: opts.intervalMs, maxAttempts: opts.maxAttempts, backoffMs: opts.backoffMs, log });
    const warnings = [];
    let budget = opts.maxLookups;
    let written = 0;

    for (const date of dates) {
        const items = await fetchPlaylist(date, { log });
        if (items === null) {
            warnings.push(`${date}: could not fetch the playlist from KMHD or the Worker; skipped`);
            continue;
        }
        if (items.length === 0) {
            log(`${date}: KMHD has no tracks logged (yet); nothing written`);
            continue;
        }
        const day = await buildDay(date, items, known, lookup, { budget, log });
        budget -= day.stats.lookedUp;
        const s = day.stats;
        log(`${date}: ${s.plays} plays, ${s.unique} unique; ${s.known} known, ${s.lookedUp} looked up `
            + `(${s.matched} matched, ${s.unmatched} no match, ${s.skipped} skipped), ${s.unresolved} left for next run`);
        if (s.unresolved) warnings.push(`${date}: ${s.unresolved} track(s) unresolved this run`);
        if (Object.keys(day.tracks).length === 0) continue;
        if (!opts.dryRun) {
            writeDayFile(date, day.tracks, s.unresolved === 0);
            written++;
        }
        if (day.stopped) {
            warnings.push(`${date}: stopped early because iTunes lookups kept failing; later dates skipped`);
            break;
        }
    }

    const ls = lookup.stats;
    log(`Done: ${written} file(s) ${opts.dryRun ? 'would be ' : ''}written; ${ls.calls} iTunes call(s), ${ls.retries} retried, ${ls.hits} matched, ${ls.misses} no match`);
    warnings.forEach(w => {
        // GitHub Actions turns this prefix into a visible annotation on the run.
        console.log((process.env.GITHUB_ACTIONS ? '::warning::' : 'WARNING: ') + w);
    });
    return 0;
}

module.exports = {
    pacificToday, addDays, recentDates, dateRange, isIsoDate, resolveDates, backfillDates, parseArgs,
    playlistKeys, normalizeItunesResult, itunesUrl, makeThrottledLookup, LookupUnavailable,
    fetchPlaylist, loadKnown, buildDay, serializeDayFile, readDayFile, isDayComplete, FIELDS, ENRICH_DIR
};

if (require.main === module) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    });
}
