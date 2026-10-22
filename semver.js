function parse(version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// Returns -1, 0 or 1; null when either version is unparseable.
function compareVersions(a, b) {
    const left = parse(a), right = parse(b);
    if (!left || !right) return null;
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
    return 0;
}

function isBelowMinimum(current, minimum) {
    return compareVersions(current, minimum) === -1;
}

module.exports = { compareVersions, isBelowMinimum };
