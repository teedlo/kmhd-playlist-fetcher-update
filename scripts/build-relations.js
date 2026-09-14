#!/usr/bin/env node
// scripts/build-relations.js
//
// Precomputes "samples", "sampled by" and "other versions" (cover/alternate
// recording) links for every unique track in headnod-tracks.json, using
// MusicBrainz — the only free, no-auth, publish-friendly (CC0 core data)
// source found for this. WhoSampled has no public API and forbids scraping
// (and Spotify acquired it in Nov 2025); SecondHandSongs' free tier is
// "private use" only and would need written authorization to publish.
// Coverage is real but uneven — MusicBrainz's community documents different
// music than WhoSampled's, so expect gaps especially on deep-cut samples.
//
// Reruns are cheap: a track already present in relations.json (even with
// every list empty, meaning "checked, nothing found") is never looked up
// again — the same "known" precedent build-enrich.js uses for iTunes.
//
// Usage:
//   node scripts/build-relations.js                       # every unresolved track in headnod-tracks.json
//   node scripts/build-relations.js --max-lookups 200      # spend at most 200 MusicBrainz calls this run
//   node scripts/build-relations.js --source headnod-tracks.json --out relations.json
//   node scripts/build-relations.js --dry-run
//
// Options:
//   --max-lookups N   stop after N MusicBrainz calls this run (a call is
//                      spent per API request, not per track — a track with
//                      a cover-work relation costs 3 calls, one with no
//                      confident match costs 1). Whatever's left unresolved
//                      is simply absent from the file for a later run.
//   --interval-ms N   minimum gap between MusicBrainz calls (default 1100:
//                      their documented per-IP limit is ~1/s)
//   --source PATH     track source file (default headnod-tracks.json)
//   --out PATH        output file (default relations.json)
//   --dry-run         build and report, but write nothing
//
// No dependencies; Node 18+ (global fetch). Run from anywhere: paths are
// resolved relative to this file.
//
// Failure policy: same as build-enrich.js — a MusicBrainz 503/429/5xx is
// retried with exponential backoff; if it keeps failing, the run stops
// looking things up, writes what it has, and exits 0 with a warning. Only a
// confirmed "no confident match" or "confirmed no relations" is recorded;
// anything unresolved this run is left out of the file rather than guessed.

'use strict';

const fs = require('fs');
const path = require('path');
const PlaylistUtils = require('../playlist-utils.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE = path.join(ROOT, 'headnod-tracks.json');
const DEFAULT_OUT = path.join(ROOT, 'relations.json');

const MB_RECORDING = 'https://musicbrainz.org/ws/2/recording';
const MB_WORK = 'https://musicbrainz.org/ws/2/work';
const USER_AGENT = 'kmhd-playlist-fetcher-update/1.0 (pge@teedlo.com)';

const NOTE = 'Built by scripts/build-relations.js from MusicBrainz (https://musicbrainz.org, CC0 core data): for every unique Headnod track, what it samples, what samples it, and other recordings of the same underlying work (a heuristic "cover versions" cluster, not authoritative). Keyed "artist|title" (lowercased), same as enrich/. mbid: null means no confident MusicBrainz match was found. Coverage is uneven — MusicBrainz is community-curated and does not specialize in samples the way WhoSampled does. Do not edit by hand; rerun the script instead.';

const DEFAULTS = {
    intervalMs: 1100,
    maxLookups: Infinity,
    maxAttempts: 6,
    backoffMs: 2000,
    fetchTimeoutMs: 20000,
    matchScoreThreshold: 90,
    dryRun: false
};

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
            case '--max-lookups': opts.maxLookups = num(a); break;
            case '--interval-ms': opts.intervalMs = num(a); break;
            case '--source': opts.source = args.shift(); break;
            case '--out': opts.out = args.shift(); break;
            case '--dry-run': opts.dryRun = true; break;
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

// ---------------- track keys ----------------

// The unique "artist|title" keys in headnod-tracks.json's track list, each
// with the {artist, title} the lookup should use (first occurrence wins).
// Station legal IDs and blank title/artist entries can't be usefully
// looked up and are skipped, same as build-enrich.js's playlistKeys.
function relationKeys(tracks) {
    const keys = new Map();
    (Array.isArray(tracks) ? tracks : []).forEach(item => {
        const meta = PlaylistUtils.mapItemFields(item);
        if (!meta.title || !meta.artist) return;
        if (PlaylistUtils.isStationLegalId(meta.title)) return;
        const key = PlaylistUtils.enrichKey(meta);
        if (!keys.has(key)) keys.set(key, { artist: meta.artist, title: meta.title });
    });
    return keys;
}

// ---------------- MusicBrainz ----------------

// Lucene special characters that would otherwise break a quoted phrase in
// an MB search query.
function luceneEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
}

function mbSearchUrl(meta) {
    const query = `artist:"${luceneEscape(meta.artist)}" AND recording:"${luceneEscape(meta.title)}"`;
    return `${MB_RECORDING}?query=${encodeURIComponent(query)}&fmt=json&limit=5`;
}

function mbRecordingUrl(mbid) {
    return `${MB_RECORDING}/${encodeURIComponent(mbid)}?inc=recording-rels+work-rels+artist-credits&fmt=json`;
}

function mbWorkUrl(workId) {
    return `${MB_WORK}/${encodeURIComponent(workId)}?inc=recording-rels+artist-credits&fmt=json`;
}

// MusicBrainz "artist-credit" arrays reconstruct into a display name via
// each credit's own name plus its trailing joinphrase (e.g. a solo artist's
// joinphrase is '', a collab's might be ' feat. ').
function creditName(credit) {
    if (!Array.isArray(credit) || !credit.length) return '';
    return credit.map(c => (c && c.name || '') + (c && c.joinphrase || '')).join('').trim();
}

// The best MusicBrainz recording match for {artist, title}, or null if
// nothing is confident enough to trust. Requires both a high search score
// and a genuinely matching artist name (MB search can rank a same-titled
// track by an unrelated artist highly when the title is distinctive).
function pickBestMatch(searchData, meta, threshold) {
    const recordings = (searchData && Array.isArray(searchData.recordings)) ? searchData.recordings : [];
    const wantArtist = PlaylistUtils.normalizeArtistKey(meta.artist);
    for (const r of recordings) {
        if ((r.score || 0) < threshold) continue;
        const gotArtist = PlaylistUtils.normalizeArtistKey(creditName(r['artist-credit']));
        if (!gotArtist) continue;
        if (gotArtist === wantArtist || gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist)) return r;
    }
    return null;
}

// Splits a recording's relations into {samples, sampledBy, workId}.
// "samples material" + direction "forward": this recording samples the
// target -> Samples. Direction "backward": the target samples this
// recording -> Sampled in. The first work ("performance") relation found
// is kept as the work id for the "other versions" lookup; a recording with
// more than one (e.g. a medley) only ever surfaces the first here.
function parseRecordingRelations(data) {
    const relations = (data && Array.isArray(data.relations)) ? data.relations : [];
    const samples = [];
    const sampledBy = [];
    let workId = null;
    relations.forEach(rel => {
        if (rel.type === 'samples material' && rel['target-type'] === 'recording' && rel.recording) {
            const entry = { artist: creditName(rel.recording['artist-credit']), title: rel.recording.title, mbid: rel.recording.id };
            if (rel.direction === 'backward') sampledBy.push(entry);
            else samples.push(entry);
        } else if (!workId && rel['target-type'] === 'work' && rel.work) {
            workId = rel.work.id;
        }
    });
    return { samples, sampledBy, workId };
}

// Every other recording that performs the same work, excluding the track
// itself. This is the "other versions" cluster (covers, alternate takes,
// live versions, …) — a heuristic grouping by MusicBrainz's own Work
// entity, not an authoritative "is a cover of" judgment. MusicBrainz often
// holds several near-duplicate recording entries for what is, to a
// listener, the same version (different masters/releases of one take), so
// entries are deduped by artist+title, not by MBID, before returning.
function parseWorkRecordings(data, selfMbid) {
    const relations = (data && Array.isArray(data.relations)) ? data.relations : [];
    const out = [];
    const seen = new Set();
    relations.forEach(rel => {
        if (rel['target-type'] === 'recording' && rel.recording && rel.recording.id !== selfMbid) {
            const artist = creditName(rel.recording['artist-credit']);
            const title = rel.recording.title;
            const dedupeKey = PlaylistUtils.enrichKey({ artist, title });
            if (seen.has(dedupeKey)) return;
            seen.add(dedupeKey);
            out.push({ artist, title, mbid: rel.recording.id });
        }
    });
    return out;
}

class LookupUnavailable extends Error {}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Returns an async call(url) -> {data} | {skipped} that spaces calls out
// by intervalMs and retries transient failures (503/429/5xx) with
// exponential backoff, mirroring build-enrich.js's makeThrottledLookup.
// After maxAttempts failures on one call, every later call throws
// LookupUnavailable immediately: MusicBrainz is refusing us and the run
// should wind down rather than hammer it.
function makeThrottledCall(options) {
    const opts = { ...DEFAULTS, fetch: globalThis.fetch, log: () => {}, sleep, now: Date.now, userAgent: USER_AGENT, ...options };
    let nextAllowed = 0;
    let unavailable = false;
    const stats = { calls: 0, retries: 0 };

    async function attempt(url) {
        const res = await opts.fetch(url, {
            headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' },
            signal: AbortSignal.timeout(opts.fetchTimeoutMs)
        });
        if (res.status === 503 || res.status === 429 || res.status >= 500) {
            throw new Error(`MusicBrainz responded ${res.status}`);
        }
        if (!res.ok) {
            return { skipped: `MusicBrainz responded ${res.status}` };
        }
        return { data: await res.json() };
    }

    async function call(url) {
        if (unavailable) throw new LookupUnavailable('MusicBrainz lookups are unavailable for the rest of this run');
        for (let n = 1; ; n++) {
            const wait = nextAllowed - opts.now();
            if (wait > 0) await opts.sleep(wait);
            nextAllowed = opts.now() + opts.intervalMs;
            stats.calls++;
            try {
                const result = await attempt(url);
                if (result.skipped) {
                    opts.log(`  skip  ${url}: ${result.skipped}`);
                    return { skipped: result.skipped };
                }
                return { data: result.data };
            } catch (e) {
                if (n >= opts.maxAttempts) {
                    unavailable = true;
                    throw new LookupUnavailable(`MusicBrainz call failed ${n} times (${e.message}); stopping lookups for this run`);
                }
                const backoff = opts.backoffMs * Math.pow(2, n - 1);
                stats.retries++;
                opts.log(`  retry ${url}: ${e.message}; waiting ${backoff / 1000}s`);
                nextAllowed = opts.now() + backoff;
            }
        }
    }

    call.stats = stats;
    call.isUnavailable = () => unavailable;
    return call;
}

// Resolves one {artist, title} against MusicBrainz: a search call, a
// detail call for samples/sampledBy/work, and (only if a work was found) a
// work call for other versions. Returns either the resolved entry (which
// may have every list empty — a confirmed "nothing found") or {skipped}
// when an ordinary (non-rate-limit) failure means this track should be
// left for a later run rather than recorded as a false non-match. Throws
// LookupUnavailable straight through when MusicBrainz has gone down.
async function resolveTrack(meta, call, options) {
    const opts = { matchScoreThreshold: DEFAULTS.matchScoreThreshold, ...options };
    const searchRes = await call(mbSearchUrl(meta));
    if (searchRes.skipped) return { skipped: searchRes.skipped };

    const best = pickBestMatch(searchRes.data, meta, opts.matchScoreThreshold);
    if (!best) return { entry: { mbid: null, samples: [], sampledBy: [], workId: null, otherVersions: [] } };

    const detailRes = await call(mbRecordingUrl(best.id));
    if (detailRes.skipped) return { skipped: detailRes.skipped };
    const { samples, sampledBy, workId } = parseRecordingRelations(detailRes.data);

    let otherVersions = [];
    if (workId) {
        const workRes = await call(mbWorkUrl(workId));
        // A failed work lookup shouldn't discard the samples data already
        // found; just leave otherVersions empty for this run.
        if (!workRes.skipped) otherVersions = parseWorkRecordings(workRes.data, best.id);
    }

    return { entry: { mbid: best.id, samples, sampledBy, workId, otherVersions } };
}

// ---------------- known relations file ----------------

// A track key present in relations.json (regardless of how many relations
// it holds) is resolved and never looked up again — the same precedent
// build-enrich.js's loadKnown sets for iTunes non-matches.
function loadKnown(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return (data && data.tracks && typeof data.tracks === 'object') ? data.tracks : {};
    } catch (e) {
        return {};
    }
}

// One track per line, keys sorted: small diffs on a rerun, byte-identical
// output when nothing changed.
function serializeRelationsFile(tracks) {
    const keys = Object.keys(tracks).sort();
    const lines = keys.map(k => `    ${JSON.stringify(k)}: ${JSON.stringify(tracks[k])}`);
    return '{\n'
        + `  "note": ${JSON.stringify(NOTE)},\n`
        + '  "tracks": {\n'
        + lines.join(',\n') + '\n'
        + '  }\n'
        + '}\n';
}

function writeRelationsFile(file, tracks) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, serializeRelationsFile(tracks));
    fs.renameSync(tmp, file);
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
    const sourceFile = opts.source || DEFAULT_SOURCE;
    const outFile = opts.out || DEFAULT_OUT;

    let source;
    try {
        source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    } catch (e) {
        console.error(`Could not read ${sourceFile}: ${e.message}`);
        return 1;
    }

    const keys = relationKeys(source.tracks);
    const known = loadKnown(outFile);
    const unresolved = [...keys.entries()].filter(([key]) => !(key in known));
    log(`${keys.size} unique track(s) in ${sourceFile}, ${keys.size - unresolved.length} already known, ${unresolved.length} to look up`);

    const call = makeThrottledCall({ intervalMs: opts.intervalMs, maxAttempts: opts.maxAttempts, backoffMs: opts.backoffMs, log });
    const tracks = { ...known };
    let budget = opts.maxLookups;
    let stopped = false;
    let matched = 0, unmatched = 0, skipped = 0, withRelations = 0;

    for (const [key, meta] of unresolved) {
        if (stopped || budget <= 0) break;
        budget--;
        let result;
        try {
            result = await resolveTrack(meta, call, { matchScoreThreshold: opts.matchScoreThreshold });
        } catch (e) {
            if (!(e instanceof LookupUnavailable)) throw e;
            log(`  ${e.message}`);
            stopped = true;
            break;
        }
        if (result.skipped) { skipped++; continue; }
        tracks[key] = result.entry;
        if (result.entry.mbid) matched++; else unmatched++;
        if (result.entry.samples.length || result.entry.sampledBy.length || result.entry.otherVersions.length) withRelations++;
    }

    const leftForNextRun = unresolved.length - (matched + unmatched + skipped);
    log(`Done: ${matched} matched (${withRelations} with at least one relation), ${unmatched} no confident match, `
        + `${skipped} skipped, ${leftForNextRun} left for next run; ${call.stats.calls} MusicBrainz call(s), ${call.stats.retries} retried`);

    if (!opts.dryRun) writeRelationsFile(outFile, tracks);

    if (stopped) console.log((process.env.GITHUB_ACTIONS ? '::warning::' : 'WARNING: ') + 'stopped early because MusicBrainz kept failing; remaining tracks left for a later run');
    return 0;
}

module.exports = {
    relationKeys, luceneEscape, mbSearchUrl, mbRecordingUrl, mbWorkUrl, creditName, pickBestMatch,
    parseRecordingRelations, parseWorkRecordings, makeThrottledCall, LookupUnavailable, resolveTrack,
    loadKnown, serializeRelationsFile, parseArgs, DEFAULT_SOURCE, DEFAULT_OUT
};

if (require.main === module) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    });
}
