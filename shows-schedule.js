// shows-schedule.js
//
// KMHD's recurring weekly show schedule, hand-transcribed from
// https://www.kmhd.org/schedule/YYYY/MM/DD/ (checked across all 7 weekdays
// on Aug 16, 2026 — the page renders the same lineup every time a given
// weekday is requested, confirming this is a fixed weekly template rather
// than day-specific programming).
//
// This is pure, DOM-free data (like playlist-utils.js) so it can be
// required from Node tests without a browser. Used by the "By Show"
// feature in index.html to know which weekday/time window to pull each
// show's tracks from, via the existing per-day playlist API.
//
// weekday: 0=Sunday ... 6=Saturday (matches JS Date#getDay()).
// start/end: 24-hour "HH:MM" local (Pacific) time, end exclusive.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.KmhdShows = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const SHOWS = [
        // Sunday
        { name: 'The Funky Elegance', weekday: 0, start: '00:00', end: '02:00', host: null },
        { name: 'Out of the Night', weekday: 0, start: '02:00', end: '08:00', host: null },
        { name: 'Hot Notes', weekday: 0, start: '08:00', end: '10:00', host: 'Andrew Oliver' },
        { name: 'Positive Vibrations', weekday: 0, start: '10:00', end: '12:00', host: 'Bryson Wallace' },
        { name: 'Songs From Cloud 9', weekday: 0, start: '12:00', end: '14:00', host: "Nicole D'Amato" },
        { name: 'The Needle Drop', weekday: 0, start: '14:00', end: '18:00', host: null },
        { name: "Steppin' Out", weekday: 0, start: '18:00', end: '19:00', host: 'Bri Drennon' },
        { name: 'Bright Moments', weekday: 0, start: '19:00', end: '21:00', host: 'Lynn Darroch' },
        { name: 'The Archive', weekday: 0, start: '21:00', end: '23:00', host: 'Bobby Smith' },
        { name: 'The Message', weekday: 0, start: '23:00', end: '24:00', host: 'Carlton Jackson' },

        // Monday
        { name: 'Out of the Night', weekday: 1, start: '00:00', end: '06:00', host: null },
        { name: 'The Morning Session', weekday: 1, start: '06:00', end: '08:00', host: 'Blaire' },
        { name: "Today's Good News", weekday: 1, start: '08:00', end: '10:00', host: 'Rev Shines' },
        { name: 'Positive Vibrations', weekday: 1, start: '10:00', end: '11:00', host: 'Bryson Wallace' },
        { name: 'The New Format', weekday: 1, start: '11:00', end: '13:00', host: 'Alex Newman' },
        { name: 'Songs From Cloud 9', weekday: 1, start: '13:00', end: '14:00', host: "Nicole D'Amato" },
        { name: 'A Smooth Ride', weekday: 1, start: '14:00', end: '16:00', host: 'Anthony Dean-Harris' },
        { name: "Takin' Off", weekday: 1, start: '16:00', end: '18:00', host: 'Bri Drennon' },
        { name: 'The Wind Down', weekday: 1, start: '18:00', end: '19:00', host: 'Derek Smith' },
        { name: 'The Brazilian Beat', weekday: 1, start: '19:00', end: '21:00', host: 'Allen "The Ambassador" Thayer' },
        { name: 'Stellar Regions', weekday: 1, start: '21:00', end: '23:00', host: 'Rob Lewis' },
        { name: 'Sounds for Plant Lovers', weekday: 1, start: '23:00', end: '24:00', host: 'Anthony Valadez' },

        // Tuesday
        { name: 'Out of the Night', weekday: 2, start: '00:00', end: '06:00', host: null },
        { name: 'The Morning Session', weekday: 2, start: '06:00', end: '08:00', host: 'Blaire' },
        { name: "Today's Good News", weekday: 2, start: '08:00', end: '10:00', host: 'Rev Shines' },
        { name: 'Positive Vibrations', weekday: 2, start: '10:00', end: '11:00', host: 'Bryson Wallace' },
        { name: 'The New Format', weekday: 2, start: '11:00', end: '13:00', host: 'Alex Newman' },
        { name: 'Songs From Cloud 9', weekday: 2, start: '13:00', end: '14:00', host: "Nicole D'Amato" },
        { name: 'A Smooth Ride', weekday: 2, start: '14:00', end: '16:00', host: 'Anthony Dean-Harris' },
        { name: "Takin' Off", weekday: 2, start: '16:00', end: '18:00', host: 'Bri Drennon' },
        { name: 'The Wind Down', weekday: 2, start: '18:00', end: '19:00', host: 'Derek Smith' },
        { name: 'Zoot Pursuits', weekday: 2, start: '19:00', end: '21:00', host: 'Blaire' },
        { name: 'Homeward Bound', weekday: 2, start: '21:00', end: '23:00', host: null },
        { name: 'Sounds for Plant Lovers', weekday: 2, start: '23:00', end: '24:00', host: 'Anthony Valadez' },

        // Wednesday
        { name: 'Out of the Night', weekday: 3, start: '00:00', end: '06:00', host: null },
        { name: 'The Morning Session', weekday: 3, start: '06:00', end: '08:00', host: 'Blaire' },
        { name: "Today's Good News", weekday: 3, start: '08:00', end: '10:00', host: 'Rev Shines' },
        { name: 'Positive Vibrations', weekday: 3, start: '10:00', end: '11:00', host: 'Bryson Wallace' },
        { name: 'The New Format', weekday: 3, start: '11:00', end: '13:00', host: 'Alex Newman' },
        { name: 'Songs From Cloud 9', weekday: 3, start: '13:00', end: '14:00', host: "Nicole D'Amato" },
        { name: 'A Smooth Ride', weekday: 3, start: '14:00', end: '16:00', host: 'Anthony Dean-Harris' },
        { name: "Takin' Off", weekday: 3, start: '16:00', end: '18:00', host: 'Bri Drennon' },
        { name: 'The Wind Down', weekday: 3, start: '18:00', end: '19:00', host: 'Derek Smith' },
        { name: 'Manteca', weekday: 3, start: '19:00', end: '21:00', host: 'disco diablo' },
        { name: 'Universal Language', weekday: 3, start: '21:00', end: '23:00', host: 'Blue Note Charlie' },
        { name: 'Sounds for Plant Lovers', weekday: 3, start: '23:00', end: '24:00', host: 'Anthony Valadez' },

        // Thursday
        { name: 'Out of the Night', weekday: 4, start: '00:00', end: '06:00', host: null },
        { name: 'The Morning Session', weekday: 4, start: '06:00', end: '08:00', host: 'Blaire' },
        { name: "Today's Good News", weekday: 4, start: '08:00', end: '10:00', host: 'Rev Shines' },
        { name: 'Positive Vibrations', weekday: 4, start: '10:00', end: '11:00', host: 'Bryson Wallace' },
        { name: 'The New Format', weekday: 4, start: '11:00', end: '13:00', host: 'Alex Newman' },
        { name: 'Songs From Cloud 9', weekday: 4, start: '13:00', end: '14:00', host: "Nicole D'Amato" },
        { name: 'A Smooth Ride', weekday: 4, start: '14:00', end: '16:00', host: 'Anthony Dean-Harris' },
        { name: "Takin' Off", weekday: 4, start: '16:00', end: '18:00', host: 'Bri Drennon' },
        { name: 'The Wind Down', weekday: 4, start: '18:00', end: '19:00', host: 'Derek Smith' },
        { name: 'Arrivals', weekday: 4, start: '19:00', end: '21:00', host: 'Adrian Anaya' },
        { name: "Loungin'", weekday: 4, start: '21:00', end: '23:00', host: 'DJ Cedric Hudson' },
        { name: 'Sounds for Plant Lovers', weekday: 4, start: '23:00', end: '24:00', host: 'Anthony Valadez' },

        // Friday
        { name: 'Out of the Night', weekday: 5, start: '00:00', end: '06:00', host: null },
        { name: 'The Morning Session', weekday: 5, start: '06:00', end: '08:00', host: 'Blaire' },
        { name: "Today's Good News", weekday: 5, start: '08:00', end: '10:00', host: 'Rev Shines' },
        { name: 'Positive Vibrations', weekday: 5, start: '10:00', end: '11:00', host: 'Bryson Wallace' },
        { name: 'The New Format', weekday: 5, start: '11:00', end: '13:00', host: 'Alex Newman' },
        { name: 'Songs From Cloud 9', weekday: 5, start: '13:00', end: '14:00', host: "Nicole D'Amato" },
        { name: 'A Smooth Ride', weekday: 5, start: '14:00', end: '16:00', host: 'Anthony Dean-Harris' },
        { name: 'Soulful Strut', weekday: 5, start: '16:00', end: '18:00', host: 'Baby Boomer' },
        { name: 'The Headnod Show', weekday: 5, start: '18:00', end: '20:00', host: 'Headnodic' },
        { name: 'Common Groove', weekday: 5, start: '20:00', end: '22:00', host: 'Noa Ver' },
        { name: 'I Like It Like That', weekday: 5, start: '22:00', end: '24:00', host: "Tom D'Antoni" },

        // Saturday
        { name: 'Homeward Bound', weekday: 6, start: '00:00', end: '02:00', host: null },
        { name: 'Out of the Night', weekday: 6, start: '02:00', end: '08:00', host: null },
        { name: 'The Brazilian Beat', weekday: 6, start: '08:00', end: '10:00', host: 'Allen "The Ambassador" Thayer' },
        { name: 'Positive Vibrations', weekday: 6, start: '10:00', end: '12:00', host: 'Bryson Wallace' },
        { name: 'Songs From Cloud 9', weekday: 6, start: '12:00', end: '14:00', host: "Nicole D'Amato" },
        { name: 'The Needle Drop', weekday: 6, start: '14:00', end: '18:00', host: null },
        { name: "Steppin' Out", weekday: 6, start: '18:00', end: '19:00', host: 'Bri Drennon' },
        { name: 'Jukebox Saturday Night', weekday: 6, start: '19:00', end: '20:00', host: null },
        { name: 'Smooth Sailing', weekday: 6, start: '20:00', end: '22:00', host: 'The Captain' },
        { name: 'The Drop Shop', weekday: 6, start: '22:00', end: '24:00', host: 'Steven Vaughn Kray' }
    ];

    // De-duplicated list of unique show names (some shows air more than
    // once a week, e.g. Positive Vibrations airs daily) with their combined
    // list of {weekday, start, end} slots. This is what the "By Show"
    // dropdown lists, and what drives which past dates get fetched.
    function uniqueShows() {
        const byName = new Map();
        SHOWS.forEach(s => {
            if (!byName.has(s.name)) {
                byName.set(s.name, { name: s.name, host: s.host, slots: [] });
            }
            const entry = byName.get(s.name);
            entry.slots.push({ weekday: s.weekday, start: s.start, end: s.end });
            // prefer a non-null host if any slot has one
            if (!entry.host && s.host) entry.host = s.host;
        });
        return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    return { SHOWS, uniqueShows };
}));
