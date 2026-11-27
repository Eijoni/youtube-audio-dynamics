(() => {
  function readPlayerMeta() {
    const player = document.getElementById('movie_player');
    const flexy = document.querySelector('ytd-watch-flexy');

    let resp = null;
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        resp = player.getPlayerResponse();
      } catch (_) {}
    }
    if (!resp && flexy && flexy.playerData) {
      resp = flexy.playerData;
    }

    const details = resp?.videoDetails || {};
    const micro = resp?.microformat?.playerMicroformatRenderer || {};

    return {
      videoId: details.videoId || new URLSearchParams(location.search).get('v') || '',
      title: details.title || '',
      author: details.author || '',
      shortDescription: details.shortDescription || '',
      category: micro.category || ''
    };
  }

  function emitMeta() {
    window.dispatchEvent(new CustomEvent('yt-ac-meta', { detail: readPlayerMeta() }));
  }

  window.addEventListener('yt-ac-request-meta', emitMeta);
  window.addEventListener('yt-navigate-finish', () => {
    emitMeta();
    setTimeout(emitMeta, 600);
  });

  emitMeta();
})();