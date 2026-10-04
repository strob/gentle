const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'www/view_alignment.html'), 'utf8');
const alignment = JSON.parse(fs.readFileSync(path.join(root, 'examples/youtube_alignment.json'), 'utf8'));

// Run the real inline viewer, with just the DOM/player surface it uses.
function page({ videoId = '', protocol = 'http:', apiLoaded = true, inline = true, downloads = true } = {}) {
    const elements = [];
    function element(tag) {
        const node = { tagName: tag, style: {}, children: [], className: '', hidden: false,
            offsetTop: 0, offsetLeft: 0, offsetWidth: 20, currentTime: 0 };
        node.classList = {
            add(value) { node.className = [...new Set(node.className.split(' ').concat(value))].join(' ').trim(); },
            remove(value) { node.className = node.className.split(' ').filter(x => x !== value).join(' '); },
            contains(value) { return node.className.split(' ').includes(value); }
        };
        node.appendChild = child => { node.children.push(child); return child; };
        node.removeAttribute = name => { delete node[name]; };
        node.setAttribute = (name, value) => { node[name] = value; };
        node.insertBefore = child => { node.children.unshift(child); };
        Object.defineProperty(node, 'innerHTML', { set(value) { node.children = []; node.html = value; }, get() { return node.html; } });
        elements.push(node);
        return node;
    }
    const ids = {};
    for (const id of ['audio', 'youtube', 'youtube-status', 'youtube-player', 'transcript', 'preloader', 'downloads']) {
        ids[id] = element('div');
    }
    ids.youtube.hidden = true;
    const audioCalls = [];
    ids.audio.play = () => { audioCalls.push(['play', ids.audio.currentTime]); return Promise.resolve(); };
    ids.audio.pause = () => audioCalls.push(['pause']);
    const document = {
        body: element('body'), head: element('head'),
        getElementById: id => ids[id], createElement: element,
        createTextNode: text => ({ textContent: text }),
        querySelectorAll: selector => elements.filter(node => node.classList.contains(selector.slice(1)))
    };
    const calls = [];
    const player = {
        time: 0,
        getCurrentTime() { return this.time; },
        seekTo(time, allowSeekAhead) { calls.push(['seek', time, allowSeekAhead]); this.time = time; },
        playVideo() { calls.push(['play']); },
        pauseVideo() { calls.push(['pause']); }
    };
    const timers = new Map();
    let timerId = 0;
    let config;
    let statusRequest;
    const context = {
        document, console,
        location: { protocol, origin: 'http://localhost:8000', pathname: '/transcriptions/demo/index.html', reload() {} },
        setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        requestAnimationFrame() {},
        XMLHttpRequest: function() {
            this.open = () => {};
            this.send = () => { statusRequest = this; };
        }
    };
    const api = { Player: function(id, options) { assert.equal(id, 'youtube-player'); config = options; return player; } };
    if (apiLoaded) context.YT = api;
    context.window = context;
    let script = template.match(/<script>([\s\S]*?)<\/script>/)[1];
    script = script.replace('var YOUTUBE_VIDEO_ID = "";', `var YOUTUBE_VIDEO_ID = ${JSON.stringify(videoId)};`);
    if (!downloads) script = script.replace('var SHOW_DOWNLOADS = true;', 'var SHOW_DOWNLOADS = false;');
    if (inline) script = script.replace('var INLINE_JSON;', `var INLINE_JSON = ${JSON.stringify(alignment)};`);
    vm.runInNewContext(script, context);
    return { context, ids, document, audioCalls, player, calls, timers,
        get config() { return config; },
        ready() { config.events.onReady({ target: player }); },
        loadApi() { context.YT = api; context.onYouTubeIframeAPIReady(); },
        respondStatus(status) { statusRequest.responseText = JSON.stringify(status); statusRequest.onload(); }
    };
}

test('audio remains the default, works from file://, and never loads YouTube', () => {
    const p = page({ protocol: 'file:', apiLoaded: false });
    assert.equal(p.document.head.children.length, 0);
    assert.equal(p.ids.youtube.hidden, true);
    p.context.wds[0].$div.onclick();
    p.context.wds[1].$div.onclick();
    p.context.wds[2].$div.onclick();
    assert.deepEqual(p.audioCalls, [['play', 0], ['play', 5]]);
    let prevented = false;
    p.context.onkeydown({ keyCode: 32, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(p.audioCalls.at(-1), ['pause']);
    assert.equal(p.ids.downloads.children.length, 2); // No server-only ZIP from file://.
});

test('audio word highlighting follows its playback time', () => {
    const p = page();
    p.ids.audio.currentTime = 0.2;
    p.context.highlight_word();
    assert.equal(p.context.wds[0].$div.classList.contains('active'), true);
    p.ids.audio.currentTime = 5.2;
    p.context.highlight_word();
    assert.equal(p.context.wds[0].$div.classList.contains('active'), false);
    assert.equal(p.context.wds[1].$div.classList.contains('active'), true);
});

test('YouTube does not autoplay and passes the page origin', () => {
    const p = page({ videoId: 'M7lc1UVf-VE' });
    assert.equal(p.config.videoId, 'M7lc1UVf-VE');
    assert.equal(p.config.playerVars.origin, p.context.location.origin);
    assert.equal(p.ids.audio.style.display, 'none');
    assert.equal(p.ids.youtube.hidden, false);
    assert.equal(Number.isNaN(p.context.media.getCurrentTime()), true);
    p.ready();
    assert.deepEqual(p.calls, []);
    assert.equal(p.timers.size, 0);
});

test('only the most recent click is played after YouTube becomes ready', () => {
    const p = page({ videoId: 'M7lc1UVf-VE', apiLoaded: false });
    assert.equal(p.document.head.children[0].src, 'https://www.youtube.com/iframe_api');
    p.context.wds[0].$div.onclick();
    p.context.wds[1].$div.onclick();
    assert.deepEqual(p.calls, []);
    p.loadApi();
    p.ready();
    assert.deepEqual(p.calls, [['seek', 5, true], ['play']]);
});

test('queued seek to zero is not discarded and missing words do not seek', () => {
    const p = page({ videoId: 'M7lc1UVf-VE' });
    p.context.wds[0].$div.onclick();
    p.ready();
    p.context.wds[2].$div.onclick();
    assert.deepEqual(p.calls, [['seek', 0, true], ['play']]);
    p.context.wds[1].$div.onclick();
    assert.deepEqual(p.calls.slice(-2), [['seek', 5, true], ['play']]);
});

test('pause cancels a queued click and pauses an initialized player', () => {
    const p = page({ videoId: 'M7lc1UVf-VE' });
    p.context.wds[1].$div.onclick();
    p.context.media.pause();
    p.ready();
    assert.deepEqual(p.calls, []);
    p.context.onkeydown({ keyCode: 32, preventDefault() {} });
    assert.deepEqual(p.calls, [['pause']]);
});

test('YouTube highlighting uses player time, not the hidden audio clock', () => {
    const p = page({ videoId: 'M7lc1UVf-VE' });
    p.ready();
    p.ids.audio.currentTime = 0.2;
    p.player.time = 5.2;
    p.context.highlight_word();
    assert.equal(p.context.wds[1].$div.classList.contains('active'), true);
    assert.equal(p.context.wds[0].$div.classList.contains('active'), false);
});

test('blocked playback and unavailable videos display actionable messages', () => {
    const p = page({ videoId: 'M7lc1UVf-VE' });
    p.ready();
    p.config.events.onAutoplayBlocked();
    assert.match(p.ids['youtube-status'].textContent, /Press Play/);
    p.config.events.onStateChange({ data: 1 });
    assert.equal(p.ids['youtube-status'].textContent, '');
    p.config.events.onError({ data: 101 });
    assert.match(p.ids['youtube-status'].textContent, /YouTube error 101/);
    p.context.wds[0].$div.onclick();
    assert.deepEqual(p.calls, []);
    assert.equal(Number.isNaN(p.context.media.getCurrentTime()), true);
});

test('YouTube rejects file:// and invalid IDs before loading external scripts', () => {
    for (const options of [{ protocol: 'file:', videoId: 'M7lc1UVf-VE' }, { videoId: 'invalid' }]) {
        const p = page({ ...options, apiLoaded: false });
        assert.equal(p.document.head.children.length, 0);
        assert.match(p.ids['youtube-status'].textContent, /HTTP or HTTPS|11-character/);
    }
});

test('loading failures, slow loading and missing Referer have useful status', () => {
    const p = page({ videoId: 'M7lc1UVf-VE', apiLoaded: false });
    for (const fn of p.timers.values()) fn();
    assert.match(p.ids['youtube-status'].textContent, /longer to load/);
    p.document.head.children[0].onerror();
    assert.match(p.ids['youtube-status'].textContent, /Unable to load YouTube/);
    assert.equal(p.timers.size, 0);
    const other = page({ videoId: 'M7lc1UVf-VE' });
    other.config.events.onError({ data: 153 });
    assert.match(other.ids['youtube-status'].textContent, /Referer header/);
});

test('alignment-in-progress hides whichever media is selected', () => {
    for (const videoId of ['', 'M7lc1UVf-VE']) {
        const p = page({ videoId, inline: false });
        p.respondStatus({ status: 'STARTED' });
        assert.equal(p.ids[videoId ? 'youtube' : 'audio'].style.visibility, 'hidden');
    }
});

test('standalone pages suppress download links and server export marker remains unique', () => {
    const p = page({ videoId: 'M7lc1UVf-VE', downloads: false });
    assert.equal(p.ids.downloads.children.length, 0);
    assert.equal(template.split('var INLINE_JSON;').length - 1, 1);
});
