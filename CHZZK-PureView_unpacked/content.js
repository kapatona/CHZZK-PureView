(() => {
  'use strict';

  const VERSION = '1.0.0';
  const HOOK_MARK = Symbol.for('chzzkPureView.hook');
  const STORAGE_KEY = 'live-player-video-track';
  const STORAGE_MARKER_KEY = '__chzzkPureView-quality-owner';
  const TRACK_1080 = { label: '1080p', width: 1920, height: 1080 };
  const TRACK_480 = { label: '480p', width: 852, height: 480 };
  const LIVE_DETAIL_RE = /api\.chzzk\.naver\.com\/service\/v[\d.]+\/channels\/[0-9a-fA-F]{32}\/live-detail/;

  function readJsonStorage(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function sameTrack(a, b) {
    return !!a && !!b && a.label === b.label && a.width === b.width && a.height === b.height;
  }

  function writeOwnedTrack(track) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(track));
    localStorage.setItem(STORAGE_MARKER_KEY, JSON.stringify({ version: VERSION, track }));
  }

  function seedPreferredQuality() {
    try {
      const current = readJsonStorage(STORAGE_KEY);
      const marker = readJsonStorage(STORAGE_MARKER_KEY);
      const owned = !!marker && sameTrack(marker.track, current);
      const legacyGate480 = !marker && sameTrack(current, TRACK_480);

      if (!current || owned || legacyGate480) {
        if (!sameTrack(current, TRACK_1080) || marker?.version !== VERSION) writeOwnedTrack(TRACK_1080);
      }
    } catch {}
  }

  function decodeBase64Utf8(raw) {
    if (!raw) return null;
    try {
      const bin = atob(String(raw).replace(/ /g, '+'));
      const bytes = Uint8Array.from(bin, (char) => char.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      try { return atob(String(raw)); } catch { return null; }
    }
  }

  function cdnUrlFromP2pPath(path) {
    try {
      const url = new URL(String(path || ''), 'https://chzzk-pureview.invalid');
      return decodeBase64Utf8(url.searchParams.get('cdn_url'));
    } catch {
      return null;
    }
  }

  function stripP2pFields(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (obj.p2pPath && !obj.path) {
      const cdn = cdnUrlFromP2pPath(obj.p2pPath);
      if (cdn) obj.path = cdn;
    }

    delete obj.p2pPath;
    delete obj.p2pPathUrlEncoding;
  }

  function mutatePlaybackJson(livePlaybackJson) {
    if (!livePlaybackJson) return livePlaybackJson;

    const wasString = typeof livePlaybackJson === 'string';
    const playback = wasString ? JSON.parse(livePlaybackJson) : livePlaybackJson;

    if (playback?.meta) playback.meta.p2p = false;
    if (Array.isArray(playback?.api)) {
      playback.api = playback.api.filter((api) => !/p2p/i.test(String(api?.name || api?.path || '')));
    }

    for (const media of playback?.media || []) {
      stripP2pFields(media);
      for (const track of media?.encodingTrack || []) stripP2pFields(track);
    }

    return wasString ? JSON.stringify(playback) : playback;
  }

  function mutateLiveDetailPayload(input) {
    try {
      const data = JSON.parse(JSON.stringify(input));
      const content = data?.content;
      if (!content) return input;

      content.dab = false;
      if (Array.isArray(content.p2pQuality)) content.p2pQuality = [];
      content.livePlaybackJson = mutatePlaybackJson(content.livePlaybackJson);

      return data;
    } catch {
      return input;
    }
  }

  function mutateJsonText(text, mutator) {
    try {
      const parsed = JSON.parse(text);
      const mutated = mutator(parsed);
      return mutated === parsed ? text : JSON.stringify(mutated);
    } catch {
      return text;
    }
  }

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input?.url || '';
  }

  function urlKind(url) {
    if (LIVE_DETAIL_RE.test(url)) return 'live-detail';
    return '';
  }

  function mutateText(kind, text) {
    if (kind === 'live-detail') return mutateJsonText(text, mutateLiveDetailPayload);
    return text;
  }

  function mutatePayload(kind, payload) {
    if (kind === 'live-detail') return mutateLiveDetailPayload(payload);
    return payload;
  }

  function installFetchHook() {
    const original = window.fetch;
    if (typeof original !== 'function' || original[HOOK_MARK]) return;

    const hooked = async function(input) {
      const response = await original.apply(this, arguments);
      try {
        const kind = urlKind(requestUrl(input));
        if (!kind) return response;
        if (kind === 'live-detail') seedPreferredQuality();

        const headers = new Headers(response.headers);
        headers.set('content-type', 'application/json;charset=utf-8');
        headers.delete('content-length');
        headers.delete('content-encoding');

        return new Response(mutateText(kind, await response.clone().text()), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch {
        return response;
      }
    };

    hooked[HOOK_MARK] = true;
    window.fetch = hooked;
  }

  function installXhrHook() {
    const proto = window.XMLHttpRequest?.prototype;
    if (!proto || proto[HOOK_MARK]) return;
    proto[HOOK_MARK] = true;

    const urlByXhr = new WeakMap();
    const textCache = new WeakMap();
    const jsonCache = new WeakMap();
    const originalOpen = proto.open;
    const textDesc = Object.getOwnPropertyDescriptor(proto, 'responseText');
    const responseDesc = Object.getOwnPropertyDescriptor(proto, 'response');

    proto.open = function(method, url) {
      try { urlByXhr.set(this, String(url || '')); } catch {}
      return originalOpen.apply(this, arguments);
    };

    function xhrUrl(xhr) {
      try { return xhr.responseURL || urlByXhr.get(xhr) || ''; }
      catch { return urlByXhr.get(xhr) || ''; }
    }

    function mutatedText(xhr, kind) {
      if (textCache.has(xhr)) return textCache.get(xhr);
      if (kind === 'live-detail') seedPreferredQuality();

      let raw = '';
      try { raw = textDesc?.get ? textDesc.get.call(xhr) : ''; } catch {}

      const text = mutateText(kind, raw);
      textCache.set(xhr, text);
      return text;
    }

    if (textDesc?.get && textDesc.configurable !== false) {
      Object.defineProperty(proto, 'responseText', {
        configurable: true,
        enumerable: textDesc.enumerable,
        get() {
          const kind = urlKind(xhrUrl(this));
          const type = this.responseType || '';
          if (this.readyState === 4 && kind && (!type || type === 'text')) return mutatedText(this, kind);
          return textDesc.get.call(this);
        },
      });
    }

    if (responseDesc?.get && responseDesc.configurable !== false) {
      Object.defineProperty(proto, 'response', {
        configurable: true,
        enumerable: responseDesc.enumerable,
        get() {
          const kind = urlKind(xhrUrl(this));
          if (this.readyState === 4 && kind) {
            const type = this.responseType || '';
            if (!type || type === 'text') return mutatedText(this, kind);
            if (type === 'json') {
              if (!jsonCache.has(this)) jsonCache.set(this, mutatePayload(kind, responseDesc.get.call(this)));
              return jsonCache.get(this);
            }
          }
          return responseDesc.get.call(this);
        },
      });
    }
  }

  installFetchHook();
  installXhrHook();
  seedPreferredQuality();
})();
