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

    return { trackStartDate, mapItemFields, cacheKey };
}));
