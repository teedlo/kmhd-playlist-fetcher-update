// playlist-utils.js
//
// Pure, DOM-free helper functions used by index.html to interpret KMHD's
// playlist API response. Pulled into their own file (rather than left
// inline in <script>) specifically so they can be unit tested with Node,
// without needing a browser or DOM.
//
// Loaded two ways:
//   - In the browser, index.html includes this via <script src="playlist-utils.js">,
//     which defines window.PlaylistUtils.
//   - In Node (tests), `require('./playlist-utils.js')` returns the same
//     object via module.exports.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PlaylistUtils = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // KMHD's API changed shape in 2026 (see index.html comments for the
    // full story). trackStartDate() understands both the new schema
    // (start.utc / start.local) and the old, iTunes-enriched schema
    // (_start_time), so the page keeps working if KMHD reverts or if we
    // ever need to replay archived old-format data.
    function trackStartDate(item) {
        if (!item) return null;
        const iso = (item.start && (item.start.utc || item.start.local)) || item._start_time;
        if (!iso) return null;
        const d = new Date(iso);
        return isNaN(d.getTime()) ? null : d;
    }

    // Normalizes a playlist item to {title, artist, album} regardless of
    // which API schema it came from. `artist` is always a plain string
    // (the new schema returns an array; the old schema returns a string).
    function mapItemFields(item) {
        if (!item) return { title: '', artist: '', album: '' };
        const title = item.title || item.trackName || '';
        const artist = Array.isArray(item.artist)
            ? item.artist.join(', ')
            : (item.artist || item.artistName || '');
        const album = item.album || item.collectionName || '';
        return { title, artist, album };
    }

    // The one key every iTunes-lookup store agrees on: "artist|title",
    // lowercased. Used verbatim by the per-day enrichment files under
    // enrich/ (built by scripts/build-enrich.js), by the in-page static
    // map that loads them, and (with a prefix) by the localStorage cache.
    // Deliberately case-insensitive so "The Beatles" and "the beatles"
    // share an entry.
    function enrichKey(meta) {
        const artist = (meta && meta.artist) || '';
        const title = (meta && meta.title) || '';
        return `${artist}|${title}`.toLowerCase();
    }

    // Builds the localStorage cache key used for iTunes Search lookups.
    function cacheKey(prefix, meta) {
        return prefix + enrichKey(meta);
    }

    // The KMHD playlist "day" a track belongs to, as YYYY-MM-DD. KMHD
    // buckets its per-day API by Portland-local date, and every item
    // carries that date at the front of start.local (old schema:
    // _start_time), so this is a string slice, not timezone math. Falls
    // back to the viewer-local calendar date only if neither is present.
    function trackDate(item) {
        if (!item) return null;
        const local = (item.start && item.start.local) || item._start_time;
        const match = local ? String(local).match(/^(\d{4}-\d{2}-\d{2})/) : null;
        if (match) return match[1];
        const d = trackStartDate(item);
        return d ? toIsoDate(d) : null;
    }

    // Pulls a 4-digit release year out of whatever date-ish field is
    // available: the new KMHD schema's `releaseDate`, or an iTunes
    // enrichment result's `releaseDate` (also ISO-ish). Returns null
    // rather than a garbage year if nothing usable is found.
    function trackYear(item) {
        if (!item) return null;
        const raw = item.releaseDate || item.release_date || null;
        if (!raw) return null;
        const match = String(raw).match(/(\d{4})/);
        if (!match) return null;
        const year = parseInt(match[1], 10);
        if (year < 1900 || year > 2100) return null;
        return year;
    }

    // Builds plain search-link URLs for services that don't have (or
    // aren't worth the setup cost of) a per-track lookup API. Every link
    // is a search results page rather than a guaranteed exact match, so
    // it degrades gracefully instead of ever 404ing.
    //
    // appleMusic is the search page too: it renders instantly with the
    // rest, and when an exact iTunes match is known (from the per-day
    // enrich/ file or a live lookup) the page swaps that same link's
    // href for the track's own Apple Music URL in place.
    function searchLinks(meta) {
        const artist = (meta && meta.artist) || '';
        const title = (meta && meta.title) || '';
        const album = (meta && meta.album) || '';
        const artistTitle = `${artist} ${title}`.trim();
        // "Artist Album" with a missing piece dropped, rather than left as a
        // stray double space (an empty `album` used to leave one in the
        // encoded query — harmless to eBay's own search, but sloppy to look
        // at in a raw URL).
        const artistAlbum = [artist, album].filter(Boolean).join(' ');
        const ebaySearch = format => artistAlbum
            ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(`${artistAlbum} ${format}`)}`
            : null;
        return {
            appleMusic: artistTitle
                ? `https://music.apple.com/us/search?term=${encodeURIComponent(artistTitle)}`
                : null,
            youtube: artistTitle
                ? `https://www.youtube.com/results?search_query=${encodeURIComponent(artistTitle + ' live')}`
                : null,
            tidal: artistTitle
                ? `https://listen.tidal.com/search?q=${encodeURIComponent(artistTitle)}`
                : null,
            // Both are plain keyword searches biased by the word "vinyl"/
            // "cd" — NOT a real eBay category filter (no `_sacat` param).
            // Verifying and wiring in eBay's actual Records/CDs category
            // IDs would tighten these, but this sandbox can't reach
            // ebay.com to confirm the current ones are still valid, so
            // that stays a possible follow-up rather than a guess baked in.
            ebayVinyl: ebaySearch('vinyl'),
            ebayCd: ebaySearch('cd'),
            wiki: artist
                ? `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(artist)}`
                : null
        };
    }

    // ---------------- per-day enrichment entries ----------------
    // The enrich/ files store each track in a compact form, about a third
    // the size of the raw iTunes fields (two years of days is tens of
    // megabytes either way, so it matters in git and on the wire):
    //   t: track id, c: collection (album) id, r: artist id,
    //   a: artwork path, h: artwork host digit, g: genre, y: release year.
    // Apple Music resolves ID-only URLs (music.apple.com/us/album/id<c>?i=<t>)
    // with a redirect to the slugged canonical page, so the slugs need not
    // be stored. Anything that doesn't fit a pattern is kept verbatim under
    // its original field name, so nothing is ever lost, and expandEntry()
    // accepts either form (older files, localStorage) unchanged.
    const TRACK_URL = /^https:\/\/music\.apple\.com\/us\/album\/[^/?]+\/(\d+)\?i=(\d+)(?:&uo=4)?$/;
    const ARTIST_URL = /^https:\/\/music\.apple\.com\/us\/artist\/[^/?]+\/(\d+)(?:\?uo=4)?$/;
    const ARTWORK_URL = /^https:\/\/is(\d)-ssl\.mzstatic\.com\/image\/thumb\/(.+)\/100x100bb\.jpg$/;

    function compactEntry(entry) {
        if (!entry) return null;
        const out = {};
        const t = TRACK_URL.exec(entry.trackViewUrl || '');
        if (t) { out.t = Number(t[2]); out.c = Number(t[1]); }
        else if (entry.trackViewUrl) out.trackViewUrl = entry.trackViewUrl;
        if (entry.t != null) { out.t = entry.t; out.c = entry.c; }   // already compact
        const r = ARTIST_URL.exec(entry.artistViewUrl || '');
        if (r) out.r = Number(r[1]);
        else if (entry.artistViewUrl) out.artistViewUrl = entry.artistViewUrl;
        if (entry.r != null) out.r = entry.r;
        const a = ARTWORK_URL.exec(entry.artworkUrl100 || '');
        if (a) { out.a = a[2]; out.h = Number(a[1]); }
        else if (entry.artworkUrl100) out.artworkUrl100 = entry.artworkUrl100;
        if (entry.a) { out.a = entry.a; out.h = entry.h || 1; }
        // The album link is the track link on every entry seen so far; keep
        // it only when it differs.
        const trackUrl = entry.trackViewUrl || (out.t ? trackUrlFor(out) : null);
        if (entry.collectionViewUrl && entry.collectionViewUrl !== trackUrl) out.collectionViewUrl = entry.collectionViewUrl;
        const genre = entry.primaryGenreName || entry.g;
        if (genre) out.g = genre;
        const year = entry.y || trackYear(entry);
        if (year) out.y = year;
        return out;
    }

    function trackUrlFor(e) {
        return `https://music.apple.com/us/album/id${e.c}?i=${e.t}`;
    }

    // Compact (or verbose) entry -> the verbose shape the pages render from.
    function expandEntry(entry) {
        if (!entry) return null;
        const trackViewUrl = entry.trackViewUrl || (entry.t != null && entry.c != null ? trackUrlFor(entry) : null);
        return {
            artworkUrl100: entry.artworkUrl100 || (entry.a ? `https://is${entry.h || 1}-ssl.mzstatic.com/image/thumb/${entry.a}/100x100bb.jpg` : null),
            trackViewUrl,
            artistViewUrl: entry.artistViewUrl || (entry.r != null ? `https://music.apple.com/us/artist/id${entry.r}` : null),
            collectionViewUrl: entry.collectionViewUrl || trackViewUrl,
            primaryGenreName: entry.primaryGenreName || entry.g || null,
            releaseDate: entry.releaseDate || (entry.y ? String(entry.y) : null)
        };
    }

    // ---------------- "By Show" helpers ----------------
    // These support browsing a show's history by cross-referencing its
    // recurring weekly time slot (from shows-schedule.js) against the
    // existing per-day playlist API — KMHD doesn't offer a per-show
    // archive endpoint, so this reconstructs one client-side.

    // "HH:MM" -> minutes since midnight.
    function minutesOfDay(hhmm) {
        const [h, m] = String(hhmm).split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
    }

    // True if `item`'s local start time falls within [slot.start, slot.end).
    // slot.end === '24:00' is treated as end-of-day (inclusive of 23:59).
    function trackInSlot(item, slot) {
        if (!item || !slot) return false;
        const d = trackStartDate(item);
        if (!d) return false;
        const mins = d.getHours() * 60 + d.getMinutes();
        const startMin = minutesOfDay(slot.start);
        const endMin = slot.end === '24:00' ? 1440 : minutesOfDay(slot.end);
        if (endMin > startMin) return mins >= startMin && mins < endMin;
        // Overnight slot (wraps past midnight) — not currently used by any
        // KMHD show, but handled for completeness.
        return mins >= startMin || mins < endMin;
    }

    // Formats a Date as YYYY-MM-DD in *local* time.
    //
    // Deliberately not toISOString(), which converts to UTC first: these
    // Dates are built from local components (midnight local), so anywhere
    // east of UTC that midnight is still the previous day in UTC and every
    // date came back shifted a day earlier. That turned "the last 3
    // Fridays" into three Thursdays for every visitor in Europe or Asia,
    // which fetched the wrong show's playlist entirely.
    function toIsoDate(d) {
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    // Returns `count` ISO dates (YYYY-MM-DD), most recent first, for the
    // given weekday (0=Sun..6=Sat) on or before `fromDateIso`. Used to
    // generate the list of past dates to fetch for a show's recurring slot.
    function pastWeekdayDates(weekday, count, fromDateIso) {
        const from = new Date(fromDateIso + 'T00:00:00');
        if (isNaN(from.getTime())) return [];
        const diff = (from.getDay() - weekday + 7) % 7;
        const mostRecent = new Date(from);
        mostRecent.setDate(from.getDate() - diff);
        const dates = [];
        for (let i = 0; i < count; i++) {
            const d = new Date(mostRecent);
            d.setDate(mostRecent.getDate() - i * 7);
            dates.push(toIsoDate(d));
        }
        return dates;
    }

    return {
        trackStartDate, trackDate, mapItemFields, enrichKey, cacheKey, trackYear, searchLinks,
        compactEntry, expandEntry, minutesOfDay, trackInSlot, pastWeekdayDates, toIsoDate
    };
}));
