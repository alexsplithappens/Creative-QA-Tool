const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, isBelowMinimum } = require('../semver');

test('compareVersions orders versions numerically', () => {
    assert.equal(compareVersions('2.1.0', '2.1.0'), 0);
    assert.equal(compareVersions('2.1.0', '2.10.0'), -1);
    assert.equal(compareVersions('3.0.0', '2.99.99'), 1);
    assert.equal(compareVersions('v2.1.1', '2.1.0'), 1);
    assert.equal(compareVersions('2.1.0-beta.1', '2.1.0'), 0);
});

test('compareVersions returns null for invalid input', () => {
    assert.equal(compareVersions('abc', '1.0.0'), null);
    assert.equal(compareVersions('1.0.0', undefined), null);
});

test('isBelowMinimum fails open on invalid input', () => {
    assert.equal(isBelowMinimum('2.0.9', '2.1.0'), true);
    assert.equal(isBelowMinimum('2.1.0', '2.1.0'), false);
    assert.equal(isBelowMinimum('2.1.0', 'garbage'), false);
});
