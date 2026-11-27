(() => {
  let retryTimer = null;

  function getUrlVideoId() {
    if (location.pathname.startsWith('/shorts/')) {
      const m = location.pathname.match(/^\/shorts\/([^/?#]+)/);
      return m ? m[1] : '';
    }
    return new URLSearchParams(location.search).get('v') || '';
  }

  function readPlayerMeta() {
    const isShorts = location.pathname.startsWith('/shorts/');
    const urlVideoId = getUrlVideoId();

    const primaryPlayer = isShorts
      ? document.getElementById('shorts-player')
      : document.getElementById('movie_player');
    const fallbackPlayer = isShorts
      ? document.getElementById('movie_player')
      : document.getElementById('shorts-player');

    let resp = null;
    for (const p of [primaryPlayer, fallbackPlayer]) {
      if (p && typeof p.getPlayerResponse === 'function') {
        try {
          const candidate = p.getPlayerResponse();
          if (candidate && candidate.videoDetails) {
            resp = candidate;
            break;
          }
        } catch (_) {}
      }
    }

    if (!resp && !isShorts) {
      const flexy = document.querySelector('ytd-watch-flexy');
      if (flexy && flexy.playerData) resp = flexy.playerData;
    }

    const details = resp?.videoDetails || {};
    const micro = resp?.microformat?.playerMicroformatRenderer || {};

    // While scrolling Shorts, playerResponse can lag behind the URL by ~150-300 ms
    const stale = Boolean(urlVideoId && details.videoId && details.videoId !== urlVideoId);

    if (stale) {
      return {
        videoId: urlVideoId,
        title: '',
        author: '',
        shortDescription: '',
        category: '',
        pending: true
      };
    }

    return {
      videoId: details.videoId || urlVideoId,
      title: details.title || '',
      author: details.author || '',
      shortDescription: details.shortDescription || '',
      category: micro.category || '',
      pending: !details.videoId && Boolean(urlVideoId)
    };
  }

  function emitMeta(attempt = 0) {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    const meta = readPlayerMeta();
    window.dispatchEvent(new CustomEvent('yt-ac-meta', { detail: meta }));

    if (meta.pending && attempt < 10) {
      retryTimer = setTimeout(() => emitMeta(attempt + 1), 200);
    }
  }

  const scheduleEmit = () => {
    emitMeta(0);
    setTimeout(() => emitMeta(1), 350);
  };

  window.addEventListener('yt-ac-request-meta', () => emitMeta(0));
  window.addEventListener('yt-navigate-finish', scheduleEmit);
  window.addEventListener('yt-page-data-updated', scheduleEmit);
  window.addEventListener('popstate', scheduleEmit);

  emitMeta(0);
})();