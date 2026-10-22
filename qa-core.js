const acorn = require('acorn');
const walk = require('acorn-walk');
const postcss = require('postcss');
const { parseGIF } = require('gifuct-js');

const LIMITS = { files: 1000, expandedBytes: 50 * 1024 * 1024, assetBytes: 500 * 1024 * 1024 };

function result(label, status, detail, fix = '') {
    return { label, status, detail, fix };
}

function statusFor(checks) {
    if (checks.some(check => check.status === 'fail')) return 'fail';
    if (checks.some(check => ['warning', 'unverified'].includes(check.status))) return 'review';
    return 'pass';
}

// Hosts that serve Google ad runtimes and libraries; trusted without fetching.
function isTrustedHost(host) {
    return /(?:^|\.)(?:2mdn\.net|gstatic\.com|googleapis\.com|doubleclick\.net|googlesyndication\.com|googletagservices\.com)$/i.test(host);
}

function dimensionCheck(metadata, profile, allowDouble = false) {
    if (!metadata.width || !metadata.height) return result('Dimensions', 'unverified', 'No usable dimensions found.', 'Set the expected dimensions from the delivery specification.');
    const size = `${metadata.width} x ${metadata.height}`;
    // CM360 accepts images up to twice the slot size, capped at 4000 x 4000.
    const doubleOf = (width, height) => allowDouble && metadata.width === width * 2 && metadata.height === height * 2;
    const tooLarge = allowDouble && (metadata.width > 4000 || metadata.height > 4000);
    if (!profile.width || !profile.height) {
        if (!profile.baseline) return result('Dimensions', 'unverified', `${size}; no expected dimensions selected.`);
        const standard = STANDARD_SIZES.find(entry => entry.width === metadata.width && entry.height === metadata.height);
        if (standard) return result('Dimensions', 'pass', `${size}; standard size: ${standard.name}.`);
        const half = STANDARD_SIZES.find(entry => doubleOf(entry.width, entry.height));
        if (half) return tooLarge ? result('Dimensions', 'fail', `${size}; exceeds the 4000 x 4000 maximum.`) : result('Dimensions', 'pass', `${size}; 2x of standard size ${half.name} (${half.width} x ${half.height}).`);
        return result('Dimensions', 'warning', `${size}; non-standard size.`, 'Verify against the campaign or publisher specification.');
    }
    if (metadata.width === profile.width && metadata.height === profile.height) return result('Dimensions', 'pass', `${size}; expected ${profile.width} x ${profile.height}.`);
    if (doubleOf(profile.width, profile.height)) return tooLarge ? result('Dimensions', 'fail', `${size}; exceeds the 4000 x 4000 maximum.`) : result('Dimensions', 'pass', `${size}; 2x of expected ${profile.width} x ${profile.height}.`);
    return result('Dimensions', 'fail', `${size}; expected ${profile.width} x ${profile.height}${allowDouble ? ' or 2x that size' : ''}.`);
}

function resolveReference(owner, reference) {
    const value = reference.trim();
    if (!value || value.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return null;
    const segments = value.startsWith('/') ? [] : owner.split('/').slice(0, -1);
    const decoded = decodeURIComponent(value.split(/[?#]/)[0]).replace(/\\/g, '/');
    for (const segment of decoded.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!segments.length) throw new Error('Reference escapes the ZIP root');
            segments.pop();
        } else segments.push(segment);
    }
    return segments.join('/');
}

function memberName(node) {
    if (!node) return '';
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression') {
        const property = node.computed ? node.property.value : node.property.name;
        return `${memberName(node.object)}.${property}`;
    }
    return '';
}

function analyzeScripts(sources, mode = 'display', incomplete = false, trustedRuntime = false, htmlElements = []) {
    const checks = [];
    let declared = false;
    let opener = false;
    let studioExit = false;
    let parseFailed = incomplete;
    let gwdExit = false;
    const storage = new Set();
    const insecure = new Set();
    for (const source of sources) {
        let tree;
        try {
            tree = acorn.parse(source.content, { ecmaVersion: 'latest', sourceType: source.module ? 'module' : 'script', locations: true, allowReturnOutsideFunction: true });
        } catch (error) {
            parseFailed = true;
            checks.push(result('JavaScript parsing', 'unverified', `${source.name}: ${error.message}`, 'Review the source and browser console.'));
            continue;
        }
        walk.ancestor(tree, {
            VariableDeclarator(node, ancestors) {
                if (/^clickTag\d*$/i.test(node.id.name || '') && !source.module && !ancestors.some(parent => /Function/.test(parent.type)) && ancestors.at(-2).kind === 'var') declared = true;
            },
            AssignmentExpression(node) {
                if (/^(?:window|globalThis)\.clickTag\d*$/i.test(memberName(node.left))) declared = true;
                if (/^(?:(?:window|globalThis)\.)?location(?:\.href)?$/.test(memberName(node.left)) && containsClickTag(node.right)) opener = true;
            },
            CallExpression(node) {
                const callee = memberName(node.callee);
                if (/^(?:window\.)?open$/.test(callee) && node.arguments[0] && containsClickTag(node.arguments[0])) opener = true;
                if (/^Enabler\.exit(?:Override)?$/.test(callee)) studioExit = true;
                if (/^gwd\.actions\.gwd(?:GoogleAd|GenericAd)\.exit(?:Override)?$/.test(callee)) gwdExit = true;
            },
            MemberExpression(node) {
                const name = memberName(node);
                if (/(?:^|\.)(?:localStorage|sessionStorage|indexedDB|openDatabase)(?:\.|$)/.test(name)) storage.add(name);
            },
            Identifier(node) {
                if (['localStorage', 'sessionStorage', 'indexedDB', 'openDatabase'].includes(node.name)) storage.add(node.name);
            },
            Literal(node) {
                if (typeof node.value === 'string' && /^http:\/\//i.test(node.value)) insecure.add(node.value);
            }
        });
    }
    if (mode === 'studio' || (mode === 'auto' && studioExit && !(declared && opener))) {
        const missing = trustedRuntime ? 'note' : (parseFailed ? 'unverified' : 'fail');
        checks.push(result('Studio exit', studioExit || gwdExit ? 'note' : missing, studioExit || gwdExit ? 'Supported exit API found. Activation and exit mapping require runtime review.' : 'No supported exit could be verified.', 'Verify the exit in Studio/CM360 preview; no untracked fallback is required.'));
    } else {
        const candidate = declared && opener || gwdExit;
        const missing = trustedRuntime ? 'note' : (parseFailed ? 'unverified' : 'fail');
        checks.push(result('Click destination', candidate ? 'note' : missing, candidate ? 'Supported click destination found. The landing URL is normally set in the ad server.' : 'A supported click destination could not be verified in the local scripts.', candidate ? 'Verify the exit in the destination platform preview.' : 'Use the destination-supported clickTag or Google Web Designer exit implementation.'));
    }
    checks.push(result('Storage APIs', storage.size ? 'warning' : (parseFailed ? 'unverified' : 'pass'), storage.size ? `Storage references: ${[...storage].join(', ')}` : 'No storage API references found in parsed local scripts.', 'Check the destination policy and whether these APIs execute.'));
    if (insecure.size) checks.push(result('HTTP strings', 'note', `${[...insecure].join(', ')}. May include default clickTag URLs; ad-server replacement depends on how each URL is used.`, 'Confirm that fetched resources and landing destinations use HTTPS.'));
    checks.push(...analyzeHardcodedDestinations(sources, parseFailed || trustedRuntime, htmlElements));
    return checks;
}

function analyzeHardcodedDestinations(sources, incomplete, htmlElements) {
    const parsed = [];
    const globals = new Map();
    const scopes = new Map();
    const findings = new Set();
    const unresolved = new Set();
    const clickAssignments = new Set();
    const isClickTag = name => /^(?:(?:window|globalThis)\.)?clickTag\d*$/i.test(name);
    const scopeFor = (ancestors, blockScoped = false) => [...ancestors].reverse().find(node => /Function/.test(node.type) || node.type === 'Program' || blockScoped && node.type === 'BlockStatement');
    const bindingsFor = (scope, source) => {
        if (scope.type === 'Program' && !source.module) return globals;
        if (!scopes.has(scope)) scopes.set(scope, new Map());
        return scopes.get(scope);
    };
    for (const source of sources) {
        try {
            const tree = acorn.parse(source.content, { ecmaVersion: 'latest', sourceType: source.module ? 'module' : 'script', locations: true, allowReturnOutsideFunction: true });
            parsed.push({ source, tree });
            walk.ancestor(tree, {
                VariableDeclarator(node, ancestors) {
                    if (node.id.type !== 'Identifier') return;
                    const scope = scopeFor(ancestors, ancestors.at(-2).kind !== 'var');
                    const bindings = bindingsFor(scope, source);
                    const entries = bindings.get(node.id.name) || [];
                    entries.push({ node: node.init, ancestors, source });
                    bindings.set(node.id.name, entries);
                },
                Function(node) {
                    const bindings = bindingsFor(node, source);
                    for (const parameter of node.params) {
                        walk.simple(parameter, { Identifier(identifier) { if (!bindings.has(identifier.name)) bindings.set(identifier.name, [{ node: null }]); } });
                    }
                }
            });
        } catch (_) { incomplete = true; }
    }
    const lookup = (name, ancestors, source) => {
        for (const scope of [...ancestors].reverse()) {
            if (!/Function/.test(scope.type) && !['Program', 'BlockStatement'].includes(scope.type)) continue;
            const entries = bindingsFor(scope, source).get(name);
            if (entries) return entries;
        }
        return null;
    };
    for (const { source, tree } of parsed) {
        walk.ancestor(tree, {
            AssignmentExpression(node, ancestors) {
                if (node.operator !== '=' || node.left.type !== 'Identifier' || isClickTag(node.left.name)) return;
                const entries = lookup(node.left.name, ancestors, source);
                if (entries) entries.push({ node: node.right, ancestors, source });
            }
        });
    }
    const elementsFor = (node, ancestors, source, visited = new Set()) => {
        if (!node || visited.has(node) || visited.size > 30) return [];
        const next = new Set(visited).add(node);
        if (node.type === 'ThisExpression' && source.htmlElement !== undefined) return [htmlElements[source.htmlElement]].filter(Boolean);
        if (node.type === 'Identifier') return (lookup(node.name, ancestors, source) || []).flatMap(entry => elementsFor(entry.node, entry.ancestors || ancestors, entry.source || source, next)).slice(0, 50);
        if (node.type === 'CallExpression') {
            const callee = memberName(node.callee);
            const selector = node.arguments[0]?.value;
            if (typeof selector !== 'string') return [];
            if (callee === 'document.createElement') return [{ tag: selector.toLowerCase(), attributes: {} }];
            if (callee === 'document.getElementById') return htmlElements.filter(element => element.attributes.id === selector);
            if (callee === 'document.querySelector') {
                const matches = htmlElements.filter(element => selector.startsWith('#') ? element.attributes.id === selector.slice(1) : selector.startsWith('.') ? (element.attributes.class || '').split(/\s+/).includes(selector.slice(1)) : element.tag === selector.toLowerCase());
                return matches.slice(0, 1);
            }
        }
        return [];
    };
    let resolutionSteps = 0;
    const strings = (node, ancestors, source, visited = new Set()) => {
        if (!node || visited.has(node) || visited.size > 30 || ++resolutionSteps > 2000) return [];
        const next = new Set(visited).add(node);
        if (node.type === 'Literal') return typeof node.value === 'string' ? [node.value] : [];
        if (node.type === 'Identifier') {
            if (isClickTag(node.name)) return [];
            return (lookup(node.name, ancestors, source) || []).flatMap(entry => strings(entry.node, entry.ancestors || ancestors, entry.source || source, next)).slice(0, 50);
        }
        if (node.type === 'MemberExpression') {
            const property = node.computed ? node.property.value : node.property.name;
            if (node.object.type === 'MemberExpression' && memberName(node.object).endsWith('.dataset') && typeof property === 'string') {
                const attribute = `data-${property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
                return elementsFor(node.object.object, ancestors, source).map(element => element.attributes[attribute]).filter(value => typeof value === 'string');
            }
            if (['href', 'action', 'formAction'].includes(property)) return elementsFor(node.object, ancestors, source).map(element => element.attributes[property.toLowerCase()]).filter(value => typeof value === 'string');
            if (node.object.type === 'Identifier') {
                const entries = lookup(node.object.name, ancestors, source) || [];
                return entries.flatMap(entry => entry.node?.type === 'ObjectExpression' ? entry.node.properties.filter(item => item.type === 'Property' && (item.key.name || item.key.value) === property).flatMap(item => strings(item.value, entry.ancestors, entry.source, next)) : []);
            }
        }
        if (node.type === 'BinaryExpression' && node.operator === '+') {
            const left = strings(node.left, ancestors, source, next);
            const right = strings(node.right, ancestors, source, next);
            return left.flatMap(prefix => right.filter(suffix => prefix.length + suffix.length <= 8192).map(suffix => prefix + suffix)).slice(0, 50);
        }
        if (node.type === 'TemplateLiteral') {
            let values = [node.quasis[0].value.cooked || ''];
            for (let index = 0; index < node.expressions.length; index++) {
                const parts = strings(node.expressions[index], ancestors, source, next);
                const suffix = node.quasis[index + 1].value.cooked || '';
                values = values.flatMap(prefix => parts.filter(part => prefix.length + part.length + suffix.length <= 8192).map(part => prefix + part + suffix)).slice(0, 50);
            }
            return values;
        }
        if (node.type === 'ConditionalExpression') return [...strings(node.consequent, ancestors, source, next), ...strings(node.alternate, ancestors, source, next)];
        if (node.type === 'LogicalExpression') return [...strings(node.left, ancestors, source, next), ...strings(node.right, ancestors, source, next)];
        if (node.type === 'CallExpression' && /^(?:(?:window|globalThis)\.)?(?:atob|decodeURIComponent|decodeURI)$/.test(memberName(node.callee))) {
            return strings(node.arguments[0], ancestors, source, next).flatMap(value => {
                try {
                    const callee = memberName(node.callee).split('.').at(-1);
                    return [callee === 'atob' ? atob(value) : callee === 'decodeURI' ? decodeURI(value) : decodeURIComponent(value)];
                } catch (_) { return []; }
            });
        }
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && memberName(node.callee).endsWith('.getAttribute') && typeof node.arguments[0]?.value === 'string') {
            return elementsFor(node.callee.object, ancestors, source).map(element => element.attributes[node.arguments[0].value.toLowerCase()]).filter(value => typeof value === 'string');
        }
        return [];
    };
    const usesClickTag = (node, ancestors, source, visited = new Set()) => {
        if (!node || visited.has(node) || visited.size > 30) return false;
        if (isClickTag(memberName(node))) return true;
        if (node.type !== 'Identifier') return false;
        const entries = lookup(node.name, ancestors, source);
        return !!entries?.length && entries.every(entry => usesClickTag(entry.node, entry.ancestors || ancestors, entry.source || source, new Set(visited).add(node)));
    };
    const isDestination = value => typeof value === 'string' && !!value.trim() && !/^(?:#|javascript:|data:|blob:|about:)/i.test(value.trim());
    const inspect = (node, value, ancestors, source, reason, override = false) => {
        const location = source.location || `${source.name}:${(node.loc?.start.line || 1) + (source.lineOffset || 0)}`;
        resolutionSteps = 0;
        const urls = strings(value, ancestors, source).filter(isDestination);
        for (const url of new Set(urls)) findings.add(`${location}: ${reason} -> ${url}`);
        const directClickTag = usesClickTag(value, ancestors, source);
        if (!urls.length && (!directClickTag || override)) unresolved.add(`${location}: ${reason}`);
    };
    const inspectAttribute = (node, target, value, ancestors, source) => {
        const elements = elementsFor(target, ancestors, source);
        if (elements.length && elements.every(element => !['a', 'area', 'form', 'button', 'input'].includes(element.tag))) return;
        inspect(node, value, ancestors, source, 'fixed link or form destination');
    };
    for (const { source, tree } of parsed) {
        walk.ancestor(tree, {
            AssignmentExpression(node, ancestors) {
                const name = memberName(node.left);
                if (/^(?:(?:window|globalThis|document|top|parent|self)\.)?location(?:\.href)?$/.test(name)) inspect(node, node.right, ancestors, source, 'fixed navigation');
                else if (/\.(?:href|action|formAction)$/.test(name)) inspectAttribute(node, node.left.object, node.right, ancestors, source);
                if (isClickTag(name)) {
                    const clickName = name.replace(/^(?:window|globalThis)\./, '').toLowerCase();
                    const initialGlobal = /^(?:window|globalThis)\./.test(name) && !ancestors.some(parent => /Function/.test(parent.type)) && !clickAssignments.has(clickName);
                    if (!initialGlobal) inspect(node, node.right, ancestors, source, 'clickTag reassignment', true);
                    clickAssignments.add(clickName);
                }
            },
            VariableDeclarator(node, ancestors) {
                if (!isClickTag(node.id.name || '')) return;
                if (source.module || ancestors.some(parent => /Function/.test(parent.type)) || clickAssignments.has((node.id.name || '').toLowerCase())) inspect(node, node.init, ancestors, source, 'local or redeclared clickTag', true);
                clickAssignments.add((node.id.name || '').toLowerCase());
            },
            CallExpression(node, ancestors) {
                const callee = memberName(node.callee);
                if (/^(?:(?:window|globalThis|top|parent|self)\.)?open$/.test(callee) && node.arguments.length) inspect(node, node.arguments[0], ancestors, source, 'fixed window.open destination');
                if (/^(?:(?:window|globalThis|document|top|parent|self)\.)?location\.(?:assign|replace)$/.test(callee)) inspect(node, node.arguments[0], ancestors, source, 'fixed navigation');
                if (callee === 'Enabler.exitOverride') inspect(node, node.arguments[1], ancestors, source, 'explicit exit override', true);
                if (/^gwd\.actions\.gwd(?:GoogleAd|GenericAd)\.exit(?:Override)?$/.test(callee) && node.arguments.length > 2) inspect(node, node.arguments[2], ancestors, source, 'explicit exit URL', true);
                if (/\.setAttribute$/.test(callee) && ['href', 'action', 'formaction'].includes(node.arguments[0]?.value)) inspectAttribute(node, node.callee.object, node.arguments[1], ancestors, source);
            }
        });
    }
    for (const element of htmlElements) {
        const attributes = element.tag === 'a' || element.tag === 'area' ? ['href'] : element.tag === 'form' ? ['action'] : ['button', 'input'].includes(element.tag) ? ['formaction'] : [];
        for (const attribute of attributes) {
            const value = element.attributes[attribute];
            if (isDestination(value)) findings.add(`${element.location}: fixed ${element.tag}[${attribute}] -> ${value}`);
        }
    }
    const checks = [result('Hardcoded click destinations', findings.size ? 'warning' : incomplete || unresolved.size ? 'unverified' : 'pass', findings.size ? [...findings].join('\n') : incomplete || unresolved.size ? 'No fixed destination confirmed; some click code could not be fully analysed.' : 'No hardcoded click destinations found in the inspected local code.', 'Use the platform-supported clickTag or configured exit instead of a fixed navigation URL. Verify the final destination in CM360/platform preview.')];
    if (unresolved.size) checks.push(result('Dynamic click destinations', 'unverified', [...unresolved].join('\n'), 'Static analysis could not resolve these destinations. Verify that they honour the configured landing URL in the destination platform preview.'));
    return checks;
}

function containsClickTag(node) {
    let found = false;
    walk.simple(node, {
        Identifier(identifier) { if (/^clickTag\d*$/i.test(identifier.name)) found = true; },
        MemberExpression(member) { if (/\.clickTag\d*$/i.test(memberName(member))) found = true; }
    });
    return found;
}

function seconds(value) {
    const match = String(value).trim().match(/^(-?\d*\.?\d+)(ms|s)$/);
    return match ? Number(match[1]) / (match[2] === 'ms' ? 1000 : 1) : null;
}

function analyzeAnimation(sources, limit) {
    let longest = 0;
    let unknown = false;
    let infinite = false;
    let found = false;
    for (const source of sources) {
        let tree;
        try { tree = postcss.parse(source.content); } catch (_) { unknown = true; continue; }
        tree.walkRules(rule => {
            let durations = [0];
            let delays = [0];
            let iterations = [1];
            rule.walkDecls(declaration => {
                const property = declaration.prop.replace(/^-(webkit|moz)-/, '');
                if (!property.startsWith('animation')) return;
                found = true;
                const values = postcss.list.comma(declaration.value);
                if (/var\(|calc\(/.test(declaration.value)) unknown = true;
                if (property === 'animation-duration') durations = values.map(seconds);
                if (property === 'animation-delay') delays = values.map(seconds);
                if (property === 'animation-iteration-count') iterations = values.map(value => value === 'infinite' ? Infinity : Number(value));
                if (property === 'animation') {
                    const parsed = values.map(value => {
                        const tokens = postcss.list.space(value);
                        const times = tokens.map(seconds).filter(time => time !== null);
                        const count = tokens.find(token => token === 'infinite' || /^\d*\.?\d+$/.test(token));
                        return { duration: times[0] || 0, delay: times[1] || 0, iterations: count === 'infinite' ? Infinity : Number(count || 1) };
                    });
                    durations = parsed.map(value => value.duration);
                    delays = parsed.map(value => value.delay);
                    iterations = parsed.map(value => value.iterations);
                }
            });
            const count = Math.max(durations.length, delays.length, iterations.length);
            for (let index = 0; index < count; index++) {
                const duration = durations[index % durations.length];
                const delay = delays[index % delays.length];
                const repeat = iterations[index % iterations.length];
                if (duration === null || delay === null || Number.isNaN(repeat)) { unknown = true; continue; }
                if (repeat === Infinity && duration > 0) infinite = true;
                longest = Math.max(longest, Math.max(0, delay + duration * repeat));
            }
        });
    }
    if (infinite) return result('CSS animation', limit ? 'fail' : 'warning', 'An infinite CSS animation was found.', 'Use a finite iteration count when required by delivery specs.');
    if (limit && longest > limit) return result('CSS animation', 'fail', `Declared playback reaches ${longest.toFixed(2)}s; selected limit is ${limit}s.`, 'Reduce repetitions, duration, or delays.');
    if (!found) return result('Animation playback', 'note', `No CSS animation declared${unknown ? '; some CSS could not be resolved' : ''}. Any motion is driven by JavaScript or the runtime, so confirm timing and the final frame in the preview.`);
    return result('Animation playback', 'note', `Longest declared CSS playback: ${longest.toFixed(2)}s. ${unknown ? 'Some CSS could not be resolved. ' : ''}JavaScript, cascading styles, and final-frame behaviour require playback review.`);
}

function inspectGif(buffer) {
    const bytes = new Uint8Array(buffer);
    let position = 13;
    const need = count => { if (position + count > bytes.length) throw new Error('Truncated GIF block'); };
    if (bytes.length < 14 || !/^GIF8[79]a$/.test(String.fromCharCode(...bytes.slice(0, 6)))) throw new Error('Invalid GIF header');
    if (bytes[10] & 128) position += 3 * 2 ** ((bytes[10] & 7) + 1);
    let repetitions = null;
    let terminated = false;
    const subBlocks = () => {
        const blocks = [];
        while (true) {
            need(1);
            const length = bytes[position++];
            if (!length) return blocks;
            need(length);
            blocks.push(bytes.slice(position, position + length));
            position += length;
        }
    };
    while (position < bytes.length) {
        need(1);
        const type = bytes[position++];
        if (type === 0x3b) { terminated = true; break; }
        if (type === 0x2c) {
            need(9);
            const packed = bytes[position + 8];
            position += 9;
            if (packed & 128) { const length = 3 * 2 ** ((packed & 7) + 1); need(length); position += length; }
            need(1);
            position++;
            subBlocks();
        } else if (type === 0x21) {
            need(1);
            const label = bytes[position++];
            if (![0xf9, 0xff, 0xfe, 0x01].includes(label)) throw new Error('Unsupported GIF extension');
            const blocks = subBlocks();
            if (label === 0xf9 && (blocks.length !== 1 || blocks[0].length !== 4)) throw new Error('Invalid GIF control block');
            if (label === 0xff && (!blocks[0] || blocks[0].length !== 11)) throw new Error('Invalid GIF application block');
            if (label === 0x01 && (!blocks[0] || blocks[0].length !== 12)) throw new Error('Invalid GIF text block');
            if (label === 0xff && blocks[0] && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(String.fromCharCode(...blocks[0])) && blocks[1]?.[0] === 1 && blocks[1].length >= 3) repetitions = blocks[1][1] | (blocks[1][2] << 8);
        } else throw new Error('Unsupported or corrupt GIF block');
    }
    if (!terminated) throw new Error('GIF trailer is missing');
    const parsed = parseGIF(buffer);
    const frames = parsed.frames.filter(frame => frame.image);
    const cycle = frames.reduce((duration, frame) => duration + (frame.gce?.delay || 10) / 100, 0);
    const animated = frames.length > 1;
    return { frames: frames.length, animated, cycle, repetitions, duration: animated ? (repetitions === 0 ? Infinity : cycle * ((repetitions ?? 0) + 1)) : 0 };
}

function checkVideo(metadata, measurement, profile) {
    const checks = [];
    const requireMaximum = (label, value, maximum, unit) => {
        if (!maximum) return;
        checks.push(result(label, Number.isFinite(value) ? (value <= maximum ? 'pass' : 'fail') : 'unverified', `${Number.isFinite(value) ? value : 'Unknown'} ${unit}; maximum ${maximum} ${unit}.`));
    };
    requireMaximum('Video duration', metadata.duration, profile.duration, 's');
    requireMaximum('Video bitrate', metadata.videoBitrate ? metadata.videoBitrate / 1000000 : null, profile.videoBitrate, 'Mbps');
    for (const [key, label] of [['videoCodec', 'Video codec'], ['audioCodec', 'Audio codec'], ['channels', 'Audio channels']]) {
        if (profile[key]) checks.push(result(label, metadata[key] === undefined || metadata[key] === null ? 'unverified' : metadata[key] === profile[key] ? 'pass' : 'fail', `${metadata[key] ?? 'Unknown'}; expected ${profile[key]}.`));
    }
    if (profile.frameRate) checks.push(result('Frame rate', !Number.isFinite(metadata.frameRate) ? 'unverified' : Math.abs(metadata.frameRate - profile.frameRate) < 0.02 ? 'pass' : 'fail', `${metadata.frameRate ?? 'Unknown'} fps; expected ${profile.frameRate} fps.`));
    if (profile.width && profile.height) checks.push(result('Resolution', metadata.width === profile.width && metadata.height === profile.height ? 'pass' : 'fail', `${metadata.width} x ${metadata.height}; expected ${profile.width} x ${profile.height}.`));
    if (profile.loudness !== null && profile.loudness !== undefined) {
        checks.push(result('Integrated loudness', !measurement || !Number.isFinite(measurement.lufs) ? 'unverified' : (Math.abs(measurement.lufs - profile.loudness) <= profile.tolerance ? 'pass' : 'fail'), measurement && Number.isFinite(measurement.lufs) ? `${measurement.lufs.toFixed(1)} LUFS; target ${profile.loudness} +/- ${profile.tolerance} LU.` : 'No finite loudness measurement available.'));
    }
    if (profile.truePeak !== null && profile.truePeak !== undefined) checks.push(result('True peak', !measurement || !Number.isFinite(measurement.truePeak) ? 'unverified' : (measurement.truePeak <= profile.truePeak ? 'pass' : 'fail'), measurement && Number.isFinite(measurement.truePeak) ? `${measurement.truePeak.toFixed(1)} dBTP; maximum ${profile.truePeak} dBTP.` : 'No true-peak measurement available.'));
    checks.push(result('Playback review', 'unverified', profile.kind === 'audio' ? 'Confirm content, sound, silence, and the ending against the brief.' : 'Confirm content, sound, safe areas, black frames, and final frame against the brief.'));
    return checks;
}

function profileForKind(profiles, kind, overrides = {}) {
    const group = kind === 'image' ? 'image' : ['video', 'audio'].includes(kind) ? 'media' : 'display';
    const profile = { ...profiles[group], ...overrides, group, kind };
    if (kind === 'audio') {
        for (const key of ['width', 'height', 'videoCodec', 'frameRate', 'videoBitrate']) delete profile[key];
    }
    return profile;
}

// Baseline applied when a limit field is left empty; entered values override it.
const DEFAULTS = {
    display: { maxKB: 200, duration: 30, maxFiles: 100 },
    image: { maxKB: 200, duration: 30 },
    media: { loudness: -20, tolerance: 4 }
};

// Per-destination baselines; ids without an entry use the general baseline.
const PRESETS = { cm360: { ...DEFAULTS, display: { maxKB: 9728, duration: 30, maxFiles: 100 }, image: { ...DEFAULTS.image, maxKB: 9728 } } };
const defaultsFor = id => PRESETS[id] || DEFAULTS;

const STANDARD_SIZES = [
    [300, 250, 'Medium Rectangle'], [336, 280, 'Large Rectangle'], [728, 90, 'Leaderboard'], [970, 90, 'Large Leaderboard'], [970, 250, 'Billboard'],
    [300, 600, 'Half Page'], [160, 600, 'Wide Skyscraper'], [120, 600, 'Skyscraper'], [300, 1050, 'Portrait'], [320, 50, 'Mobile Banner'],
    [320, 100, 'Large Mobile Banner'], [300, 50, 'Mobile Banner (Alt)'], [468, 60, 'Full Banner'], [320, 480, 'Mobile Interstitial'],
    [480, 320, 'Mobile Interstitial (Landscape)'], [1024, 768, 'Tablet Interstitial'], [768, 1024, 'Tablet Interstitial (Portrait)'],
    [200, 200, 'Small Square'], [250, 250, 'Square'], [240, 400, 'Vertical Rectangle'], [180, 150, 'Small Rectangle'], [125, 125, 'Button'],
    [234, 60, 'Half Banner'], [120, 90, 'Button 1'], [120, 60, 'Button 2'], [88, 31, 'Micro Bar'],
    [1800, 1000, 'Background Skin'], [1920, 1080, 'Background Skin (Full HD)'], [2560, 1440, 'Background Skin (2K)']
].map(([width, height, name]) => ({ width, height, name }));

module.exports = { DEFAULTS, defaultsFor, STANDARD_SIZES, isTrustedHost, dimensionCheck, LIMITS, result, statusFor, resolveReference, analyzeScripts, analyzeAnimation, inspectGif, checkVideo, profileForKind };