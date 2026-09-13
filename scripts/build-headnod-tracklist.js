#!/usr/bin/env node
// scripts/build-headnod-tracklist.js
//
// Precomputes "every track The Headnod Show has ever played" into one file,
// headnod-tracks.json, so headnod-tracklist.html can load it with a single
// fetch instead of asking each visitor's browser to fetch and merge every
// known Friday's KMHD playlist itself (~224 requests as of this writing,
// growing by one every week).
//
// Makes NO iTunes lookups of its own: Apple Music links/art/genre for every
// track are already sitting in enrich/YYYY-MM-DD.json (built by
// scripts/build-enrich.js), so this script only merges data that already
// exists — KMHD's own per-Friday playlist plus whatever that day's enrich
// file already knows.
//
// Usage:
//   node scripts/build-headnod-tracklist.js              # rebuild the whole known range
//   node scripts/build-headnod-tracklist.js --dry-run    # build and report, write nothing
//   node scripts/build-headnod-tracklist.js --out /tmp/x.json   # write elsewhere (testing)
//
// Always rebuilds the complete known range (every Friday from
// PlaylistUtils.HEADNOD_KNOWN_START through the newest one that's finished
// airing) rather than incrementally — this script makes no rate-limited
// calls, so a full rebuild is cheap, and it keeps the output deterministic:
// re-running with nothing new to report writes a byte-identical file, so
// the scheduled workflow's "commit only if something changed" check works
// as intended.
//
// Resilience: if a Friday's KMHD fetch fails, that date's tracks are reused
// from the *previous* headnod-tracks.json (if it has them) rather than
// silently dropping a week's worth of tracks until the next run happens to
// succeed.
//
// No dependencies; Node 18+ (global fetch). Run from anywhere: paths are
// resolved relative to this file.

'use strict';

const fs = require('fs');
const path = require('path');
const PlaylistUtils = require('../playlist-utils.js');
const KmhdShows = require('../shows-schedule.js');
const buildEnrich = require('./build-enrich.js');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'headnod-tracks.json');
const ENRICH_DIR = buildEnrich.ENRICH_DIR;

const NOTE = 'Built by scripts/build-headnod-tracklist.js: every track logged during The Headnod Show\'s slot, across every known Friday, merged with whatever enrich/YYYY-MM-DD.json already knows about each track (see PlaylistUtils.expandEntry for the compact t/c/r/a/h/g/y fields). Do not edit by hand; rerun the script instead.';

const DEFAULTS = { concurrency: 8, dryRun: false };

// ---------------- the show's own slot ----------------

function headnodSlot() {
    const show = KmhdShows.uniqueShows().find(s => s.name === 'The Headnod Show');
    return (show && show.slots && show.slots[0]) || { weekday: 5, start: '18:00', end: '20:00' };
}

// ---------------- which Fridays are "known" ----------------
// Same logic as headnod-tracklist.html's own newestFinishedFriday()/
// allKnownFridays(), duplicated here rather than shared because one runs in
// a browser and the other in Node — but both lean on the same
// PlaylistUtils helpers, so they can't drift on what a "Friday" or "known
// since" means, only on how they decide "has this Friday finished airing".

function newestFinishedFriday(now) {
    const parts = {};
    new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'short', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(now || new Date()).forEach(p => { parts[p.type] = p.value; });
    const pacificToday = `${parts.year}-${parts.month}-${parts.day}`;
    const stillAiring = parts.weekday === 'Fri' && parseInt(parts.hour, 10) < 20;
    const recent = PlaylistUtils.pastWeekdayDates(5, 2, pacificToday);
    return stillAiring ? recent[1] : recent[0];
}

function allKnownFridays(now) {
    const newest = newestFinishedFriday(now);
    const oldest = new Date(PlaylistUtils.HEADNOD_KNOWN_START + 'T00:00:00');
    const newestDate = new Date(newest + 'T00:00:00');
    const weeks = Math.round((newestDate - oldest) / (7 * 24 * 60 * 60 * 1000)) + 1;
    if (weeks <= 0) return [newest];
    return PlaylistUtils.pastWeekdayDates(5, weeks, newest).reverse();   // oldest first
}

// ---------------- command line ----------------

function parseArgs(argv) {
    const opts = { ...DEFAULTS };
    const args = argv.slice();
    while (args.length) {
        const a = args.shift();
        switch (a) {
            case '--dry-run': opts.dryRun = true; break;
            case '--out': opts.out = args.shift(); break;
            case '--concurrency': {
                const v = Number(args.shift());
                if (!Number.isFinite(v) || v < 1) throw new Error('--concurrency needs a positive number');
                opts.concurrency = v;
                break;
            }
            case '--help': case '-h': opts.help = true; break;
            default: throw new Error(`Unknown option: ${a}`);
        }
    }
    return opts;
}

function usage() {
    return fs.readFileSync(__filename, 'utf8').split('\n')
        .slice(1).filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, ''))
        .join('\n');
}

// ---------------- concurrency-limited fetch ----------------
// Same shape as headnod-tracklist.html's own fetchAllFridays: at most
// `concurrency` requests in flight at once, reporting each as it settles.

async function mapWithConcurrency(items, concurrency, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
    await Promise.all(workers);
    return results;
}

// ---------------- previous output, for the fetch-failure fallback ----------------

function loadPreviousTracksByDate(file) {
    const byDate = new Map();
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return byDate; }
    (data && Array.isArray(data.tracks) ? data.tracks : []).forEach(t => {
        if (!t || !t.date) return;
        if (!byDate.has(t.date)) byDate.set(t.date, []);
        byDate.get(t.date).push(t);
    });
    return byDate;
}

// ---------------- building one Friday's tracks ----------------
// Loads every enrich/*.json into one Map (buildEnrich.loadKnown), same as
// build-enrich.js itself does, so a track resolved in ANY day's file is
// found regardless of which date's file it happened to be looked up from.

function buildRecord(item, date, enrichEntry) {
    const meta = PlaylistUtils.mapItemFields(item);
    const record = { date, title: meta.title, artist: meta.artist, album: meta.album };
    if (item.start) record.start = item.start;
    else if (item._start_time) record._start_time = item._start_time;
    if (item.releaseDate) record.releaseDate = item.releaseDate;
    if (item.artworkUrl) record.artworkUrl = item.artworkUrl;
    if (enrichEntry) Object.assign(record, enrichEntry);   // already compact — see loadKnown()
    return record;
}

function buildFridayTracks(date, items, slot, known) {
    const inSlot = (items || []).filter(item => PlaylistUtils.trackInSlot(item, slot));
    inSlot.sort((a, b) => {
        const ta = PlaylistUtils.trackStartDate(a), tb = PlaylistUtils.trackStartDate(b);
        return (ta ? ta.getTime() : 0) - (tb ? tb.getTime() : 0);
    });
    return inSlot.map(item => {
        const meta = PlaylistUtils.mapItemFields(item);
        const enrichEntry = meta.title && meta.artist ? known.get(PlaylistUtils.enrichKey(meta)) : undefined;
        return buildRecord(item, date, enrichEntry);
    });
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
    const outFile = opts.out ? path.resolve(opts.out) : OUTPUT_FILE;
    const slot = headnodSlot();
    const dates = allKnownFridays();
    const known = buildEnrich.loadKnown(ENRICH_DIR);
    const previous = loadPreviousTracksByDate(outFile);
    log(`${dates.length} Friday(s) to check, ${known.size} enrich entr(y/ies) loaded, previous output has ${previous.size} date(s)`);

    const warnings = [];
    let fetchFailures = 0;
    let fallbackDates = 0;

    const perDay = await mapWithConcurrency(dates, opts.concurrency, async date => {
        const items = await buildEnrich.fetchPlaylist(date, { log });
        if (items === null) {
            fetchFailures++;
            const fallback = previous.get(date);
            if (fallback) {
                fallbackDates++;
                warnings.push(`${date}: KMHD fetch failed; reused ${fallback.length} track(s) from the previous output`);
                return fallback;
            }
            warnings.push(`${date}: KMHD fetch failed and there is no previous data for this date; skipped`);
            return [];
        }
        return buildFridayTracks(date, items, slot, known);
    });

    const tracks = [].concat(...perDay);
    const knownDates = new Set(tracks.map(t => t.date));
    log(`Done: ${tracks.length} track play(s) across ${knownDates.size} known Friday(s) `
        + `(${dates.length} checked, ${fetchFailures} fetch failure(s), ${fallbackDates} filled from previous output)`);

    const output = { note: NOTE, tracks };
    // Pretty-printed for readable diffs (mirrors build-enrich.js's own
    // "one track per line" day files); buildFridayTracks' stable per-day
    // sort is what actually makes a rebuild that finds nothing new produce
    // byte-identical output, not the formatting itself.
    const pretty = JSON.stringify(output, null, 2) + '\n';

    if (!opts.dryRun) {
        const tmp = `${outFile}.tmp`;
        fs.writeFileSync(tmp, pretty);
        fs.renameSync(tmp, outFile);
        log(`Wrote ${outFile}`);
    } else {
        log(`--dry-run: would write ${outFile} (${Buffer.byteLength(pretty)} bytes)`);
    }

    warnings.forEach(w => {
        console.log((process.env.GITHUB_ACTIONS ? '::warning::' : 'WARNING: ') + w);
    });
    return 0;
}

module.exports = {
    headnodSlot, newestFinishedFriday, allKnownFridays, parseArgs,
    mapWithConcurrency, loadPreviousTracksByDate, buildRecord, buildFridayTracks,
    OUTPUT_FILE
};

if (require.main === module) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    });
}
