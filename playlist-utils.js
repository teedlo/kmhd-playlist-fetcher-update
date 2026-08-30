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

    // Builds the localStorage cache key used for iTunes Search lookups.
    // Deliberately case-insensitive so "The Beatles" and "the beatles"
    // share a cache entry.
    function cacheKey(prefix, meta) {
        const artist = (meta && meta.artist) || '';
        const title = (meta && meta.title) || '';
        return prefix + `${artist}|${title}`.toLowerCase();
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
    function searchLinks(meta) {
        const artist = (meta && meta.artist) || '';
        const title = (meta && meta.title) || '';
        const album = (meta && meta.album) || '';
        const artistTitle = `${artist} ${title}`.trim();
        return {
            youtube: artistTitle
                ? `https://www.youtube.com/results?search_query=${encodeURIComponent(artistTitle + ' live')}`
                : null,
            tidal: artistTitle
                ? `https://listen.tidal.com/search?q=${encodeURIComponent(artistTitle)}`
                : null,
            ebayVinyl: (artist || album)
                ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(`${artist} ${album} vinyl`.trim())}`
                : null,
            wiki: artist
                ? `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(artist)}`
                : null
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
        trackStartDate, mapItemFields, cacheKey, trackYear, searchLinks,
        minutesOfDay, trackInSlot, pastWeekdayDates, toIsoDate
    };
}));
