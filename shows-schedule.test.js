// Unit tests for shows-schedule.js, run with Node's built-in test runner:
//   node --test

const test = require('node:test');
const assert = require('node:assert/strict');
const { SHOWS, uniqueShows } = require('./shows-schedule.js');

test('SHOWS: every entry has a name, weekday 0-6, and start/end times', () => {
    assert.ok(SHOWS.length > 0);
    SHOWS.forEach(s => {
        assert.equal(typeof s.name, 'string');
        assert.ok(s.name.length > 0);
        assert.ok(s.weekday >= 0 && s.weekday <= 6, `${s.name} has invalid weekday ${s.weekday}`);
        assert.match(s.start, /^\d{2}:\d{2}$/, `${s.name} has invalid start ${s.start}`);
        assert.match(s.end, /^\d{2}:\d{2}$/, `${s.name} has invalid end ${s.end}`);
    });
});

test('SHOWS: each weekday is fully covered with no gaps or overlaps', () => {
    for (let weekday = 0; weekday <= 6; weekday++) {
        const day = SHOWS.filter(s => s.weekday === weekday).sort((a, b) => a.start.localeCompare(b.start));
        assert.ok(day.length > 0, `weekday ${weekday} has no shows`);
        assert.equal(day[0].start, '00:00', `weekday ${weekday} doesn't start at midnight`);
        assert.equal(day[day.length - 1].end, '24:00', `weekday ${weekday} doesn't end at midnight`);
        for (let i = 1; i < day.length; i++) {
            assert.equal(day[i].start, day[i - 1].end, `weekday ${weekday} has a gap/overlap around ${day[i].name}`);
        }
    }
});

test('The Headnod Show airs Friday 18:00-20:00', () => {
    const slot = SHOWS.find(s => s.name === 'The Headnod Show');
    assert.ok(slot);
    assert.equal(slot.weekday, 5);
    assert.equal(slot.start, '18:00');
    assert.equal(slot.end, '20:00');
    assert.equal(slot.host, 'Headnodic');
});

test('uniqueShows: collapses a show airing on multiple days into one entry with multiple slots', () => {
    const shows = uniqueShows();
    const positiveVibrations = shows.find(s => s.name === 'Positive Vibrations');
    assert.ok(positiveVibrations);
    assert.equal(positiveVibrations.host, 'Bryson Wallace');
    assert.ok(positiveVibrations.slots.length >= 5, 'Positive Vibrations airs most days of the week');
});

test('uniqueShows: is sorted alphabetically by name', () => {
    const names = uniqueShows().map(s => s.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, sorted);
});

test('uniqueShows: every show has a name, even when host is null', () => {
    uniqueShows().forEach(s => {
        assert.ok(s.name);
        assert.ok(Array.isArray(s.slots) && s.slots.length > 0);
    });
});
