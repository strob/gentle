// Output-only viewer. No audio download, alignment service or upload is involved.
export function normalizeAlignment(data, transcript = data?.transcript) {
  if (!data || !Array.isArray(data.words) || typeof transcript !== 'string') {
    throw new Error('Alignment must contain a transcript string and a words array.');
  }
  // Gentle's Python offsets count Unicode code points, not UTF-16 code units.
  const text = Array.from(transcript);
  const segments = [];
  let offset = 0;
  let ignored = 0;
  let untimed = 0;
  for (const word of data.words) {
    if (word?.case === 'not-found-in-transcript') { ignored++; continue; }
    if (!word || !Number.isInteger(word.startOffset) || !Number.isInteger(word.endOffset) ||
        word.startOffset < offset || word.endOffset <= word.startOffset || word.endOffset > text.length) {
      ignored++;
      continue;
    }
    if (word.startOffset > offset) segments.push({ text: text.slice(offset, word.startOffset).join('') });
    const timed = (word.case === 'success' || word.case === undefined) &&
      Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end > word.start;
    const segment = { text: text.slice(word.startOffset, word.endOffset).join('') };
    if (timed) {
      segment.start = word.start;
      segment.end = word.end;
      // Invalid phonemes do not invalidate an otherwise usable word interval.
      segment.phones = Array.isArray(word.phones) && word.phones.every(phone =>
        typeof phone?.phone === 'string' && Number.isFinite(phone.duration) && phone.duration > 0)
        ? word.phones.map(phone => ({ label: phone.phone.split('_')[0], duration: phone.duration })) : [];
    } else { segment.untimed = true; untimed++; }
    segments.push(segment);
    offset = word.endOffset;
  }
  if (offset < text.length) segments.push({ text: text.slice(offset).join('') });
  return { segments, ignored, untimed };
}

export function activeSegment(segments, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return -1;
  // Half-open intervals include zero and clear stale highlights in gaps.
  // Overlapping intervals use the last matching word in transcript order.
  let active = -1;
  segments.forEach((segment, index) => {
    if (segment.start <= seconds && seconds < segment.end) active = index;
  });
  return active;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const millis = Math.floor(seconds * 1000);
  return `${Math.floor(millis / 60000)}:${String(Math.floor(millis / 1000) % 60).padStart(2, '0')}.${String(millis % 1000).padStart(3, '0')}`;
}

export function playerError(code) {
  const reasons = {
    2: 'Invalid YouTube video ID.',
    5: 'YouTube could not play this video in this browser.',
    100: 'The video is unavailable, removed or private.',
    101: 'The video owner does not allow embedded playback.',
    150: 'The video owner does not allow embedded playback.',
    153: 'YouTube requires a referring site. Serve this page over HTTP(S) and allow its Referer header.'
  };
  return `YouTube error ${code}: ${reasons[code] || 'Playback failed.'}`;
}

export function createViewer(document, alignment) {
  const get = id => document.getElementById(id);
  const transcript = get('transcript');
  const status = get('status');
  const clock = get('time');
  const phones = get('phones');
  const pause = get('pause');
  const buttons = new Map();
  let player = null;
  let ready = false;
  let active = -1;
  let phoneNodes = [];
  transcript.replaceChildren();
  alignment.segments.forEach((segment, index) => {
    if (segment.start === undefined) {
      const span = document.createElement('span');
      span.textContent = segment.text;
      if (segment.untimed) { span.className = 'untimed'; span.title = 'No valid word timing'; }
      transcript.appendChild(span);
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'word';
    button.textContent = segment.text;
    button.title = `Seek to ${formatTime(segment.start)}`;
    button.dataset.start = String(segment.start);
    button.dataset.end = String(segment.end);
    button.disabled = true;
    button.addEventListener('click', () => {
      if (!ready) return;
      // Keep playback in the user's click event. A seek alone can stay paused.
      player.seekTo(segment.start, true);
      player.playVideo();
      // Do not highlight the requested time: YouTube may still be buffering.
    });
    transcript.appendChild(button);
    buttons.set(index, button);
  });
  get('alignment-status').textContent = `${buttons.size} timed words; ${alignment.untimed} untimed words; ${alignment.ignored} ignored alignment records.`;
  pause.addEventListener('click', () => { if (ready) player.pauseVideo(); });
  function enable(enabled) {
    ready = enabled;
    buttons.forEach(button => { button.disabled = !enabled; });
    pause.disabled = !enabled;
  }
  function highlight(seconds) {
    const next = activeSegment(alignment.segments, seconds);
    if (next !== active) {
      if (buttons.has(active)) {
        buttons.get(active).classList.remove('active');
        buttons.get(active).removeAttribute('aria-current');
      }
      active = next;
      phones.replaceChildren();
      phoneNodes = [];
      if (buttons.has(active)) {
        buttons.get(active).classList.add('active');
        buttons.get(active).setAttribute('aria-current', 'true');
        for (const phone of alignment.segments[active].phones) {
          const span = document.createElement('span');
          span.textContent = phone.label;
          phones.appendChild(span);
          phoneNodes.push(span);
        }
      }
    }
    if (active !== -1) {
      let start = alignment.segments[active].start;
      alignment.segments[active].phones.forEach((phone, index) => {
        phoneNodes[index].classList.toggle('active', seconds >= start && seconds < start + phone.duration);
        start += phone.duration;
      });
    }
  }
  return {
    setPlayer(value) { player = value; enable(true); status.textContent = 'Ready. Use the video controls or click an aligned word.'; this.tick(); },
    tick() {
      if (!ready) return;
      const seconds = player.getCurrentTime();
      clock.textContent = formatTime(seconds);
      highlight(seconds);
    },
    state(code) {
      if (!ready) return;
      const labels = { '-1': 'Ready', 0: 'Ended', 1: 'Playing', 2: 'Paused', 3: 'Buffering', 5: 'Cued' };
      status.textContent = `${labels[code] || 'Ready'}. Click an aligned word to seek and play.`;
      this.tick();
    },
    blocked() { status.textContent = "Playback was blocked by the browser. Press Play in the YouTube player, then try the word again."; },
    fail(message) { enable(false); status.textContent = message; highlight(NaN); clock.textContent = '—'; },
    dispose() { enable(false); highlight(NaN); }
  };
}

export function loadYouTube(window, document) {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const script = document.createElement('script');
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.onYouTubeIframeAPIReady = previous;
      if (error) reject(error); else resolve(window.YT);
    };
    const timeout = window.setTimeout(() => finish(new Error('YouTube player did not load. Check your connection or content blocker, then reload.')), 15000);
    window.onYouTubeIframeAPIReady = () => { finish(); if (typeof previous === 'function') previous(); };
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => finish(new Error('Could not load the YouTube player. Check your connection or content blocker, then reload.'));
    document.head.appendChild(script);
  });
}

export async function startViewer(config, window = globalThis.window, document = globalThis.document) {
  const status = document.getElementById('status');
  let viewer;
  let player;
  let interval;
  let readyTimeout;
  try {
    if (!/^https?:$/.test(window.location.protocol)) throw new Error('Serve this folder over HTTP(S); file:// cannot load the alignment and identify the embedded player.');
    if (!/^[A-Za-z0-9_-]{11}$/.test(config.videoId)) throw new Error('Set videoId to an 11-character YouTube video ID.');
    const response = await window.fetch(config.alignmentUrl);
    if (!response.ok) throw new Error(`Could not load alignment JSON (HTTP ${response.status}).`);
    const data = await response.json();
    let transcript = data?.transcript;
    if (config.transcriptUrl) {
      const textResponse = await window.fetch(config.transcriptUrl);
      if (!textResponse.ok) throw new Error(`Could not load transcript (HTTP ${textResponse.status}).`);
      transcript = await textResponse.text();
    }
    viewer = createViewer(document, normalizeAlignment(data, transcript));
    status.textContent = 'Loading YouTube player…';
    const YT = await loadYouTube(window, document);
    readyTimeout = window.setTimeout(() => viewer.fail('YouTube player is not ready. Check embedding permissions and your connection, then reload.'), 15000);
    player = new YT.Player('player', {
      width: '100%', height: '100%', videoId: config.videoId,
      playerVars: { origin: window.location.origin, playsinline: 1 },
      events: {
        onReady(event) {
          window.clearTimeout(readyTimeout);
          window.clearInterval(interval);
          viewer.setPlayer(event.target);
          interval = window.setInterval(() => viewer.tick(), 100);
        },
        onStateChange: event => viewer.state(event.data),
        onError(event) { window.clearTimeout(readyTimeout); window.clearInterval(interval); viewer.fail(playerError(event.data)); },
        onAutoplayBlocked: () => viewer.blocked()
      }
    });
    window.addEventListener('pagehide', () => {
      window.clearInterval(interval);
      window.clearTimeout(readyTimeout);
      viewer.dispose();
      player.destroy();
    }, { once: true });
    window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
    return viewer;
  } catch (error) {
    window.clearTimeout(readyTimeout);
    window.clearInterval(interval);
    const message = `Cannot open viewer: ${error.message}`;
    if (viewer) viewer.fail(message); else status.textContent = message;
    return null;
  }
}
