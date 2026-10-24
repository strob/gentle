import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeAlignment, activeSegment, formatTime, playerError, createViewer, loadYouTube, startViewer } from './viewer.mjs';

// Synthetic DOM/API fixtures test the integration contract, not YouTube playback.
const sample = JSON.parse(fs.readFileSync(new URL('./align.json', import.meta.url)));
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.events = {};
    this.classes = new Set(); this.disabled = false; this.text = '';
    this.classList = {
      add: name => this.classes.add(name), remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name),
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)
    };
  }
  set className(value) { this.classes = new Set(value.split(' ')); }
  get className() { return [...this.classes].join(' '); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(event, handler) { this.events[event] = handler; }
  click() { if (!this.disabled) this.events.click?.(); }
}
function fixture() {
  const nodes = Object.fromEntries(['transcript', 'status', 'time', 'phones', 'pause', 'alignment-status'].map(id => [id, new Element()]));
  const document = { head: new Element('head'), createElement: tag => new Element(tag), getElementById: id => nodes[id] };
  const calls = [];
  const player = { seconds: 0, getCurrentTime() { return this.seconds; }, seekTo: (...args) => calls.push(['seekTo', ...args]), playVideo: () => calls.push(['playVideo']), pauseVideo: () => calls.push(['pauseVideo']), destroy: () => calls.push(['destroy']) };
  const viewer = createViewer(document, normalizeAlignment(sample));
  return { nodes, document, player, viewer, calls, buttons: nodes.transcript.children.filter(node => node.tagName === 'BUTTON') };
}
function environment() {
  const f = fixture();
  const timers = new Map(); const intervals = new Map(); const events = {}; let next = 0;
  const window = {
    location: { protocol: 'http:', origin: 'http://localhost:8000', reload() {} },
    fetch: async () => ({ ok: true, json: async () => sample }),
    setTimeout: callback => { timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id),
    setInterval: callback => { intervals.set(++next, callback); return next; }, clearInterval: id => intervals.delete(id),
    addEventListener: (event, handler) => { events[event] = handler; },
    YT: { Player: class { constructor(id, options) { f.options = options; f.playerId = id; return f.player; } } }
  };
  return { ...f, window, timers, intervals, events, get options() { return f.options; }, get playerId() { return f.playerId; } };
}
const word = (start, end, extra = {}) => ({ case: 'success', startOffset: 0, endOffset: 1, start, end, ...extra });

test('Gentle output preserves text and separates missing word timings', () => {
  const result = normalizeAlignment(sample);
  assert.equal(result.segments.map(segment => segment.text).join(''), sample.transcript);
  assert.equal(result.segments.filter(segment => segment.start !== undefined).length, 4);
  assert.equal(result.untimed, 1);
  assert.equal(result.ignored, 0);
});

test('zero, exact end boundaries, gaps, last word and invalid time are unambiguous', () => {
  const segments = normalizeAlignment(sample).segments;
  const textAt = time => segments[activeSegment(segments, time)]?.text ?? null;
  assert.deepEqual([0, 2.999, 3, 4, 5, 8, 10, 13, 15, 17.999, 18, NaN, -1].map(textAt),
    ['Zero', 'Zero', null, null, 'First', null, '<safe>', null, 'Last', 'Last', null, null, null]);
});

test('overlaps use the last transcript word, with no assumed chronological sort', () => {
  const segments = [{ start: 4, end: 8 }, { start: 2, end: 6 }];
  assert.equal(activeSegment(segments, 5), 1);
  assert.equal(activeSegment(segments, 7), 0);
});

test('Python Unicode offsets preserve emoji and unescaped markup as literal text', () => {
  const result = normalizeAlignment({ transcript: '😀 <b>&', words: [{ ...word(0, 1), startOffset: 2, endOffset: 6 }] });
  assert.deepEqual(result.segments.map(segment => segment.text), ['😀 ', '<b>&']);
  const f = fixture();
  assert.equal(f.nodes.transcript.textContent, sample.transcript);
  assert.equal(f.buttons[2].textContent, '<safe>');
  assert.equal(f.buttons[2].children.length, 0);
});

test('invalid offsets, duplicate ranges and speech absent from transcript do not corrupt text', () => {
  const data = { transcript: 'A B', words: [word(0, 1), word(2, 3), { startOffset: -1, endOffset: 2 }, { startOffset: 2, endOffset: 99 }, { case: 'not-found-in-transcript', word: '<script>' }, { ...word(2, 3), startOffset: 2, endOffset: 3 }] };
  const result = normalizeAlignment(data);
  assert.equal(result.segments.map(segment => segment.text).join(''), 'A B');
  assert.equal(result.ignored, 4);
  assert.equal(result.segments.filter(segment => segment.start !== undefined).length, 2);
});

test('null, string, missing, negative and reversed timing never become seek targets', () => {
  for (const [start, end] of [[null, 1], ['0', 1], [undefined, 1], [-1, 1], [0, 0], [2, 1], [0, Infinity]]) {
    const result = normalizeAlignment({ transcript: 'A', words: [word(start, end)] });
    assert.equal(result.untimed, 1);
    assert.equal(result.segments[0].start, undefined);
  }
  assert.equal(normalizeAlignment({ transcript: 'A', words: [word(0, 1, { case: 'not-found-in-audio' })] }).untimed, 1);
  assert.throws(() => normalizeAlignment({ words: [] }), /transcript/);
  assert.throws(() => normalizeAlignment({ transcript: 'A', words: null }), /words array/);
});

test('word click waits for player readiness, then seeks zero and plays synchronously', () => {
  const f = fixture();
  f.buttons[0].click(); assert.deepEqual(f.calls, []);
  f.viewer.setPlayer(f.player);
  f.buttons[0].click();
  assert.deepEqual(f.calls, [['seekTo', 0, true], ['playVideo']]);
  f.nodes.pause.click(); assert.deepEqual(f.calls.at(-1), ['pauseVideo']);
});

test('highlight follows actual player time across seek, buffering, pause and gaps', () => {
  const f = fixture(); f.viewer.setPlayer(f.player);
  assert.equal(f.buttons[0].attributes['aria-current'], 'true');
  f.buttons[3].click();
  assert.equal(f.buttons[0].classList.contains('active'), true, 'requested time is not actual playback time');
  f.player.seconds = 15.2; f.viewer.state(3);
  assert.equal(f.buttons[3].attributes['aria-current'], 'true');
  assert.equal(f.buttons[0].attributes['aria-current'], undefined);
  f.viewer.state(2); assert.equal(f.buttons[3].classList.contains('active'), true);
  f.player.seconds = 18; f.viewer.tick();
  assert.equal(f.buttons.some(button => button.classList.contains('active')), false);
  assert.equal(f.nodes.time.textContent, '0:18.000');
});

test('first phoneme, successive phoneme and gap cleanup use player time', () => {
  const f = fixture(); f.viewer.setPlayer(f.player);
  assert.equal(f.nodes.phones.children[0].classList.contains('active'), true);
  f.player.seconds = 1; f.viewer.tick();
  assert.equal(f.nodes.phones.children[0].classList.contains('active'), false);
  assert.equal(f.nodes.phones.children[1].classList.contains('active'), true);
  f.player.seconds = 3; f.viewer.tick(); assert.equal(f.nodes.phones.children.length, 0);
  assert.deepEqual(normalizeAlignment({ transcript: 'A', words: [word(0, 1, { phones: [{ phone: 'A', duration: -1 }] })] }).segments[0].phones, []);
});

test('blocked playback stays actionable; player errors disable seek and clear highlights', () => {
  const f = fixture(); f.viewer.setPlayer(f.player); f.viewer.blocked();
  assert.match(f.nodes.status.textContent, /Press Play/);
  assert.equal(f.buttons[0].disabled, false);
  f.viewer.fail(playerError(153)); f.buttons[0].click();
  assert.match(f.nodes.status.textContent, /Referer/);
  assert.equal(f.buttons.every(button => button.disabled), true);
  assert.equal(f.buttons.some(button => button.classList.contains('active')), false);
  assert.deepEqual(f.calls, []);
  for (const code of [2, 5, 100, 101, 150, 153, 999]) assert.match(playerError(code), new RegExp(String(code)));
});

test('formatting retains millisecond precision and long-video minutes', () => {
  assert.equal(formatTime(0), '0:00.000'); assert.equal(formatTime(3601.125), '60:01.125');
  assert.equal(formatTime(NaN), '—'); assert.equal(formatTime(-1), '—');
});

test('real start path fetches Gentle data, configures official player and cleans up', async () => {
  const f = environment();
  const viewer = await startViewer({ videoId: 'M7lc1UVf-VE', alignmentUrl: './align.json' }, f.window, f.document);
  assert.ok(viewer);
  assert.equal(f.nodes.transcript.textContent, sample.transcript);
  assert.equal(f.playerId, 'player');
  assert.equal(f.options.videoId, 'M7lc1UVf-VE');
  assert.deepEqual(f.options.playerVars, { origin: 'http://localhost:8000', playsinline: 1 });
  assert.equal(f.timers.size, 1);
  f.options.events.onReady({ target: f.player });
  assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 1);
  f.options.events.onReady({ target: f.player });
  assert.equal(f.intervals.size, 1, 'duplicate readiness must not create another polling loop');
  f.nodes.transcript.children.find(node => node.tagName === 'BUTTON').click();
  assert.deepEqual(f.calls, [['seekTo', 0, true], ['playVideo']]);
  f.player.seconds = 15.5;
  [...f.intervals.values()][0]();
  assert.equal(f.nodes.time.textContent, '0:15.500');
  assert.equal(f.nodes.transcript.children.find(node => node.attributes['aria-current']).textContent, 'Last');
  f.options.events.onStateChange({ data: 2 }); assert.match(f.nodes.status.textContent, /Paused/);
  f.options.events.onAutoplayBlocked(); assert.match(f.nodes.status.textContent, /blocked/);
  f.options.events.onError({ data: 100 }); assert.match(f.nodes.status.textContent, /unavailable/);
  assert.equal(f.intervals.size, 0);
  f.events.pagehide();
  assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0);
  assert.deepEqual(f.calls.at(-1), ['destroy']);
});

test('player readiness timeout keeps words disabled and reports a usable next step', async () => {
  const f = environment();
  await startViewer({ videoId: 'M7lc1UVf-VE', alignmentUrl: './align.json' }, f.window, f.document);
  [...f.timers.values()][0]();
  assert.match(f.nodes.status.textContent, /not ready/);
  assert.equal(f.nodes.transcript.children.filter(node => node.tagName === 'BUTTON').every(button => button.disabled), true);
});

test('player constructor failure cancels readiness timer and preserves the error', async () => {
  const f = environment();
  f.window.YT.Player = class { constructor() { throw new Error('Player unavailable'); } };
  assert.equal(await startViewer({ videoId: 'M7lc1UVf-VE', alignmentUrl: './align.json' }, f.window, f.document), null);
  assert.match(f.nodes.status.textContent, /Player unavailable/);
  assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0);
});

test('start path rejects invalid config, HTTP failures and malformed JSON visibly', async () => {
  for (const change of [
    f => { f.window.location.protocol = 'file:'; },
    f => { f.config.videoId = 'bad'; },
    f => { f.window.fetch = async () => ({ ok: false, status: 404 }); },
    f => { f.window.fetch = async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } }); }
  ]) {
    const f = environment(); f.config = { videoId: 'M7lc1UVf-VE', alignmentUrl: './align.json' }; change(f);
    assert.equal(await startViewer(f.config, f.window, f.document), null);
    assert.match(f.nodes.status.textContent, /Cannot open viewer/);
    assert.equal(f.timers.size, 0);
  }
});

test('separate transcript input uses its exact offsets without HTML interpretation', async () => {
  const f = environment(); let count = 0;
  f.window.fetch = async () => ++count === 1 ? { ok: true, json: async () => ({ words: [word(0, 1, { endOffset: 3 })] }) } : { ok: true, text: async () => '<b>' };
  await startViewer({ videoId: 'M7lc1UVf-VE', alignmentUrl: './align.json', transcriptUrl: './text.txt' }, f.window, f.document);
  assert.equal(count, 2); assert.equal(f.nodes.transcript.textContent, '<b>');
});

test('official API loader handles readiness, load failure and timeout without retries', async () => {
  for (const mode of ['ready', 'error', 'timeout']) {
    const f = environment(); delete f.window.YT;
    const pending = loadYouTube(f.window, f.document);
    const script = f.document.head.children[0];
    assert.equal(script.src, 'https://www.youtube.com/iframe_api');
    if (mode === 'ready') { f.window.YT = { Player() {} }; f.window.onYouTubeIframeAPIReady(); assert.equal(await pending, f.window.YT); }
    if (mode === 'error') { script.onerror(); await assert.rejects(pending, /Could not load/); }
    if (mode === 'timeout') { [...f.timers.values()][0](); await assert.rejects(pending, /did not load/); }
    assert.equal(f.timers.size, 0); assert.equal(f.document.head.children.length, 1);
  }
});
