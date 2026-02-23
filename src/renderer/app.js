(() => {
  'use strict';

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  const audio = $('#audio-player');
  const views = $$('.view');
  const navBtns = $$('.nav-btn');

  $('#btn-minimize').onclick = () => window.snowify.minimize();
  $('#btn-maximize').onclick = () => window.snowify.maximize();
  $('#btn-close').onclick = () => window.snowify.close();

  const state = {
    currentView: 'home',
    queue: [],
    originalQueue: [],
    queueIndex: -1,
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    volume: 0.7,
    playlists: [],
    likedSongs: [],
    recentTracks: [],
    followedArtists: [],
    currentPlaylistId: null,
    isLoading: false,
    musicOnly: true,
    autoplay: false,
    audioQuality: 'bestaudio',
    videoQuality: '720',
    videoPremuxed: true,
    animations: true,
    effects: true,
    theme: 'dark',
    discordRpc: false,
    country: '',
    searchHistory: []
  };

  function saveState() {
    localStorage.setItem('snowify_state', JSON.stringify({
      playlists: state.playlists,
      likedSongs: state.likedSongs,
      recentTracks: state.recentTracks,
      followedArtists: state.followedArtists,
      volume: state.volume,
      shuffle: state.shuffle,
      repeat: state.repeat,
      musicOnly: state.musicOnly,
      autoplay: state.autoplay,
      audioQuality: state.audioQuality,
      videoQuality: state.videoQuality,
      videoPremuxed: state.videoPremuxed,
      animations: state.animations,
      effects: state.effects,
      theme: state.theme,
      discordRpc: state.discordRpc,
      country: state.country,
      searchHistory: state.searchHistory
    }));
    localStorage.setItem('snowify_lastSave', String(Date.now()));
    cloudSaveDebounced();
  }

  function loadState() {
    try {
      // Migrate old 'snowfy' localStorage keys to 'snowify'
      if (localStorage.getItem('snowfy_state') && !localStorage.getItem('snowify_state')) {
        localStorage.setItem('snowify_state', localStorage.getItem('snowfy_state'));
        localStorage.removeItem('snowfy_state');
      }
      if (localStorage.getItem('snowfy_migrated_v2') && !localStorage.getItem('snowify_migrated_v2')) {
        localStorage.setItem('snowify_migrated_v2', localStorage.getItem('snowfy_migrated_v2'));
        localStorage.removeItem('snowfy_migrated_v2');
      }
      // One-time migration: clear data from old yt-dlp implementation
      if (!localStorage.getItem('snowify_migrated_v2')) {
        localStorage.removeItem('snowify_state');
        localStorage.setItem('snowify_migrated_v2', '1');
        return;
      }
      const saved = JSON.parse(localStorage.getItem('snowify_state'));
      if (saved) {
        state.playlists = saved.playlists || [];
        state.likedSongs = saved.likedSongs || [];
        state.recentTracks = saved.recentTracks || [];
        state.followedArtists = saved.followedArtists || [];
        state.volume = saved.volume ?? 0.7;
        state.shuffle = saved.shuffle ?? false;
        state.repeat = saved.repeat || 'off';
        state.musicOnly = saved.musicOnly ?? true;
        state.autoplay = saved.autoplay ?? false;
        state.audioQuality = saved.audioQuality || 'bestaudio';
        state.videoQuality = saved.videoQuality || '720';
        state.videoPremuxed = saved.videoPremuxed ?? true;
        state.animations = saved.animations ?? true;
        state.effects = saved.effects ?? true;
        state.theme = saved.theme || 'dark';
        state.discordRpc = saved.discordRpc ?? false;
        state.country = saved.country || '';
        state.searchHistory = saved.searchHistory || [];
      }
    } catch (_) {}
  }

  function updateGreeting() {
    const h = new Date().getHours();
    const text = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    $('#greeting-time').textContent = text;
  }

  function switchView(name) {
    const targetView = $(`#view-${name}`);
    const alreadyActive = state.currentView === name && targetView && targetView.classList.contains('active');

    state.currentView = name;
    views.forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    navBtns.forEach(b => b.classList.toggle('active', b.dataset.view === name));

    if (alreadyActive && targetView && state.animations) {
      targetView.style.animation = 'none';
      targetView.offsetHeight;
      targetView.style.animation = '';
    }

    if (_lyricsVisible) {
      _lyricsVisible = false;
      lyricsPanel.classList.add('hidden');
      lyricsPanel.classList.remove('visible');
      btnLyrics.classList.remove('active');
      stopLyricsSync();
    }

    if (name === 'home') {
      renderHome();
    }
    if (name === 'explore') {
      renderExplore();
    }
    if (name === 'search') {
      setTimeout(() => $('#search-input').focus(), 100);
    }
    if (name === 'library') {
      renderLibrary();
    }

    updateFloatingSearch();
  }

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // ── Floating search pill ──
  const floatingSearch = $('#floating-search');
  floatingSearch.addEventListener('click', () => switchView('search'));

  function updateFloatingSearch() {
    const show = ['home', 'explore', 'library', 'artist', 'album', 'playlist'].includes(state.currentView);
    floatingSearch.classList.toggle('hidden', !show);
  }

  let searchTimeout = null;
  const searchInput = $('#search-input');
  const searchClear = $('#search-clear');
  const searchResults = $('#search-results');
  const searchSuggestions = $('#search-suggestions');
  let suggestionsTimeout = null;
  let activeSuggestionIndex = -1;

  // ─── Search History ───

  function addToSearchHistory(query) {
    const q = query.trim();
    if (!q) return;
    state.searchHistory = state.searchHistory.filter(h => h.toLowerCase() !== q.toLowerCase());
    state.searchHistory.unshift(q);
    saveState();
  }

  // ─── Search Suggestions ───

  const ICON_CLOCK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  const ICON_SEARCH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M16 16l4.5 4.5" stroke-linecap="round"/></svg>';
  const ICON_TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';

  function closeSuggestions() {
    searchSuggestions.classList.add('hidden');
    searchSuggestions.innerHTML = '';
    activeSuggestionIndex = -1;
  }

  function renderSuggestionDropdown(items) {
    if (!items.length) {
      closeSuggestions();
      return;
    }
    activeSuggestionIndex = -1;

    // Find where text items end and direct results begin for separator
    const lastTextIdx = items.reduce((acc, item, i) =>
      (item.type === 'history' || item.type === 'text') ? i : acc, -1);
    const hasDirectResults = items.some(item => item.type === 'artist' || item.type === 'album' || item.type === 'song');

    let idx = 0;
    searchSuggestions.innerHTML = items.map((item, i) => {
      let separator = '';
      if (hasDirectResults && lastTextIdx >= 0 && i === lastTextIdx + 1) {
        separator = '<div class="suggestion-separator"></div>';
      }
      const dataIdx = idx++;
      if (item.type === 'artist') {
        return separator + `<div class="search-suggestion-item" data-index="${dataIdx}" data-type="artist" data-artist-id="${escapeHtml(item.artistId || '')}">
          <img class="suggestion-thumb suggestion-thumb-round" src="${escapeHtml(item.thumbnail || '')}" alt="" />
          <div class="suggestion-info">
            <div class="suggestion-title">${escapeHtml(item.name)}</div>
            <div class="suggestion-subtitle">Artist${item.subtitle ? ' \u00b7 ' + escapeHtml(item.subtitle) : ''}</div>
          </div>
        </div>`;
      }
      if (item.type === 'album') {
        return separator + `<div class="search-suggestion-item" data-index="${dataIdx}" data-type="album" data-album-id="${escapeHtml(item.albumId || '')}" data-item-idx="${i}">
          <img class="suggestion-thumb" src="${escapeHtml(item.thumbnail || '')}" alt="" />
          <div class="suggestion-info">
            <div class="suggestion-title">${escapeHtml(item.name)}</div>
            <div class="suggestion-subtitle">Album${item.subtitle ? ' \u00b7 ' + escapeHtml(item.subtitle) : ''}</div>
          </div>
        </div>`;
      }
      if (item.type === 'song') {
        return separator + `<div class="search-suggestion-item" data-index="${dataIdx}" data-type="song" data-song-idx="${i}">
          <img class="suggestion-thumb" src="${escapeHtml(item.thumbnail || '')}" alt="" />
          <div class="suggestion-info">
            <div class="suggestion-title">${escapeHtml(item.title)}</div>
            <div class="suggestion-subtitle">Song \u00b7 ${renderArtistLinks(item)}</div>
          </div>
        </div>`;
      }
      // history or text
      return `<div class="search-suggestion-item" data-index="${dataIdx}" data-type="${item.type}" data-text="${escapeHtml(item.text)}">
        <span class="search-suggestion-icon">${item.type === 'history' ? ICON_CLOCK : ICON_SEARCH}</span>
        <span class="search-suggestion-text">${escapeHtml(item.text)}</span>
        ${item.type === 'history' ? `<button class="search-suggestion-delete" data-query="${escapeHtml(item.text)}" title="Remove">${ICON_TRASH}</button>` : ''}
      </div>`;
    }).join('');
    searchSuggestions.classList.remove('hidden');

    // Bind clickable artist links inside song suggestions
    bindArtistLinks(searchSuggestions);
    searchSuggestions.querySelectorAll('.artist-link[data-artist-id]').forEach(link => {
      link.addEventListener('click', () => {
        const q = searchInput.value.trim();
        if (q) addToSearchHistory(q);
        searchInput.value = '';
        searchClear.classList.add('hidden');
        closeSuggestions();
      });
    });

    // Bind click handlers
    $$('.search-suggestion-item', searchSuggestions).forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.search-suggestion-delete')) return;
        const type = el.dataset.type;
        if (type === 'artist') {
          const q = searchInput.value.trim();
          if (q) addToSearchHistory(q);
          searchInput.value = '';
          searchClear.classList.add('hidden');
          closeSuggestions();
          openArtistPage(el.dataset.artistId);
        } else if (type === 'album') {
          const albumItem = items[parseInt(el.dataset.itemIdx)];
          const q = searchInput.value.trim();
          if (q) addToSearchHistory(q);
          searchInput.value = '';
          searchClear.classList.add('hidden');
          closeSuggestions();
          showAlbumDetail(el.dataset.albumId, albumItem ? { name: albumItem.name, thumbnail: albumItem.thumbnail } : null);
        } else if (type === 'song') {
          const songItem = items[parseInt(el.dataset.songIdx)];
          if (songItem) {
            const q = searchInput.value.trim();
            if (q) addToSearchHistory(q);
            searchInput.value = '';
            searchClear.classList.add('hidden');
            closeSuggestions();
            playFromList([songItem], 0);
          }
        } else {
          const text = el.dataset.text;
          searchInput.value = text;
          searchClear.classList.toggle('hidden', !text);
          closeSuggestions();
          addToSearchHistory(text);
          performSearch(text);
        }
      });
    });
    $$('.search-suggestion-delete', searchSuggestions).forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const query = btn.dataset.query;
        state.searchHistory = state.searchHistory.filter(h => h.toLowerCase() !== query.toLowerCase());
        saveState();
        updateSuggestions(searchInput.value.trim());
      });
    });
  }

  async function updateSuggestions(query) {
    if (!query) {
      // Show last 5 history items
      const historyItems = state.searchHistory.slice(0, 5).map(h => ({ text: h, type: 'history' }));
      renderSuggestionDropdown(historyItems);
      return;
    }

    const lowerQ = query.toLowerCase();

    // Show matching history immediately (up to 3)
    const historyMatches = state.searchHistory
      .filter(h => h.toLowerCase().includes(lowerQ))
      .slice(0, 3)
      .map(h => ({ text: h, type: 'history' }));

    renderSuggestionDropdown(historyMatches);

    // Fetch API suggestions
    const snapshotQuery = searchInput.value.trim();
    const apiResponse = await window.snowify.searchSuggestions(query);

    // Stale check — input may have changed while awaiting
    if (searchInput.value.trim() !== snapshotQuery) return;

    // Backward compat: handle old string[] format
    const textSuggestions = Array.isArray(apiResponse) ? apiResponse : (apiResponse.textSuggestions ?? []);
    const directResults = Array.isArray(apiResponse) ? [] : (apiResponse.directResults ?? []);

    // Dedup text suggestions against history matches
    const shownSet = new Set(historyMatches.map(h => h.text.toLowerCase()));
    const textItems = textSuggestions
      .filter(s => !shownSet.has(s.toLowerCase()))
      .slice(0, 3)
      .map(s => ({ text: s, type: 'text' }));

    // Split direct results: max 1 artist, max 1 album, max 3 songs
    const artistItems = directResults.filter(r => r.type === 'artist').slice(0, 1);
    const albumItems = directResults.filter(r => r.type === 'album').slice(0, 1);
    const songItems = directResults.filter(r => r.type === 'song').slice(0, 3);

    const combined = [...historyMatches, ...textItems, ...artistItems, ...albumItems, ...songItems];
    renderSuggestionDropdown(combined);
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    searchClear.classList.toggle('hidden', !q);
    clearTimeout(searchTimeout);
    clearTimeout(suggestionsTimeout);
    if (!q) {
      renderSearchEmpty();
      updateSuggestions('');
      return;
    }
    searchTimeout = setTimeout(() => performSearch(q), 400);
    suggestionsTimeout = setTimeout(() => updateSuggestions(q), 250);
  });

  searchInput.addEventListener('keydown', (e) => {
    const items = $$('.search-suggestion-item', searchSuggestions);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!items.length) return;
      activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === activeSuggestionIndex));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === activeSuggestionIndex));
    } else if (e.key === 'Escape') {
      closeSuggestions();
    } else if (e.key === 'Enter') {
      clearTimeout(searchTimeout);
      clearTimeout(suggestionsTimeout);
      if (activeSuggestionIndex >= 0 && items[activeSuggestionIndex]) {
        const el = items[activeSuggestionIndex];
        const type = el.dataset.type;
        if (type === 'artist' || type === 'album' || type === 'song') {
          el.click();
        } else {
          const text = el.dataset.text;
          searchInput.value = text;
          searchClear.classList.toggle('hidden', !text);
          closeSuggestions();
          addToSearchHistory(text);
          performSearch(text);
        }
      } else {
        const q = searchInput.value.trim();
        if (q) {
          closeSuggestions();
          addToSearchHistory(q);
          performSearch(q);
        }
      }
    }
  });

  searchInput.addEventListener('focus', () => {
    updateSuggestions(searchInput.value.trim());
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-input-wrap')) {
      closeSuggestions();
    }
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.classList.add('hidden');
    renderSearchEmpty();
    closeSuggestions();
    searchInput.focus();
  });

  // filtering
  state.musicOnly = true;

  function renderSearchEmpty() {
    searchResults.innerHTML = `
      <div class="empty-state search-empty">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#535353" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="M16 16l4.5 4.5" stroke-linecap="round"/></svg>
        <p>Search for songs, artists, or albums</p>
      </div>`;
  }

  async function performSearch(query) {
    searchResults.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
    try {
      const [results, artists] = await Promise.all([
        window.snowify.search(query, state.musicOnly),
        window.snowify.searchArtists(query)
      ]);

      if (!results.length && !artists.length) {
        searchResults.innerHTML = `
          <div class="empty-state">
            <p>No results found for "${escapeHtml(query)}"</p>
          </div>`;
        return;
      }

      searchResults.innerHTML = '';

      // Show top matching artist
      const topArtist = artists[0];
      if (topArtist) {
        const artistSection = document.createElement('div');
        artistSection.innerHTML = `
          <h3 class="search-section-header">Artists</h3>
          <div class="artist-result-card" data-artist-id="${escapeHtml(topArtist.artistId)}">
            <img class="artist-result-avatar" src="${escapeHtml(topArtist.thumbnail || '')}" alt="" />
            <div class="artist-result-info">
              <div class="artist-result-name">${escapeHtml(topArtist.name)}</div>
              <div class="artist-result-label">Artist${topArtist.subtitle ? ' · ' + escapeHtml(topArtist.subtitle) : ''}</div>
            </div>
          </div>`;
        searchResults.appendChild(artistSection);

        artistSection.querySelectorAll('.artist-result-card').forEach(card => {
          card.addEventListener('click', () => {
            const id = card.dataset.artistId;
            if (id) openArtistPage(id);
          });
        });
      }

      // Show songs
      if (results.length) {
        const songsHeader = document.createElement('div');
        songsHeader.innerHTML = `<h3 class="search-section-header">Songs</h3>`;
        searchResults.appendChild(songsHeader);

        const tracksWrapper = document.createElement('div');
        searchResults.appendChild(tracksWrapper);
        renderTrackList(tracksWrapper, results, 'search');
      }
    } catch (err) {
      searchResults.innerHTML = `<div class="empty-state"><p>Search failed. Please try again.</p></div>`;
    }
  }

  function renderTrackList(container, tracks, context) {
    const showPlays = tracks.some(t => t.plays);
    const modifier = showPlays ? ' has-plays' : '';

    let html = `
      <div class="track-list-header${modifier}">
        <span>#</span>
        <span>Title</span>
        <span>Artist</span>
        <span></span>
        ${showPlays ? '<span style="text-align:right">Plays</span>' : ''}
      </div>`;

    tracks.forEach((track, i) => {
      const isPlaying = state.queue[state.queueIndex]?.id === track.id && state.isPlaying;
      const isLiked = state.likedSongs.some(t => t.id === track.id);

      html += `
        <div class="track-row ${isPlaying ? 'playing' : ''}${modifier}"
             data-track-id="${track.id}" data-context="${context}" data-index="${i}" draggable="true">
          <div class="track-num">
            <span class="track-num-text">${isPlaying ? '♫' : i + 1}</span>
            <span class="track-num-play">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
            </span>
          </div>
          <div class="track-main">
            <img class="track-thumb" src="${escapeHtml(track.thumbnail)}" alt="" loading="lazy" />
            <div class="track-details">
              <div class="track-title">${escapeHtml(track.title)}</div>
            </div>
          </div>
          <div class="track-artist-col">${renderArtistLinks(track)}</div>
          <div class="track-like-col">
            <button class="track-like-btn${isLiked ? ' liked' : ''}" title="Like">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
              </svg>
            </button>
          </div>
          ${showPlays ? `<div class="track-plays">${escapeHtml(track.plays || '')}</div>` : ''}
        </div>`;
    });

    container.innerHTML = html;

    // Click + drag + like handlers
    container.querySelectorAll('.track-row').forEach(row => {
      const idx = parseInt(row.dataset.index);
      const track = tracks[idx];
      row.addEventListener('click', () => playFromList(tracks, idx));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e, tracks[idx]);
      });
      row.addEventListener('dragstart', (e) => {
        if (track) startTrackDrag(e, track);
      });
      const likeBtn = row.querySelector('.track-like-btn');
      if (likeBtn && track) {
        likeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const wasLiked = toggleLike(track);
          likeBtn.classList.toggle('liked', state.likedSongs.some(t => t.id === track.id));
          if (wasLiked) spawnHeartParticles(likeBtn);
        });
      }
    });

    bindArtistLinks(container);
  }

  function showContextMenu(e, track) {
    removeContextMenu();
    const isLiked = state.likedSongs.some(t => t.id === track.id);
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    let playlistSection = '';
    if (state.playlists.length >= 5) {
      // Use a submenu that flies out on hover
      const subItems = state.playlists.map(p =>
        `<div class="context-menu-item context-sub-item" data-action="add-to-playlist" data-pid="${p.id}">${escapeHtml(p.name)}</div>`
      ).join('');
      playlistSection = `
        <div class="context-menu-divider"></div>
        <div class="context-menu-item context-menu-has-sub" data-action="none">
          <span>Add to playlist</span>
          <span class="sub-arrow">▸</span>
          <div class="context-submenu">${subItems}</div>
        </div>`;
    } else if (state.playlists.length) {
      const inlineItems = state.playlists.map(p =>
        `<div class="context-menu-item" data-action="add-to-playlist" data-pid="${p.id}">${escapeHtml(p.name)}</div>`
      ).join('');
      playlistSection = '<div class="context-menu-divider"></div>' + inlineItems;
    }

    menu.innerHTML = `
      <div class="context-menu-item" data-action="play">Play</div>
      <div class="context-menu-item" data-action="play-next">Play Next</div>
      <div class="context-menu-item" data-action="add-queue">Add to Queue</div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="watch-video">Watch Video</div>
      <div class="context-menu-item" data-action="like">${isLiked ? 'Unlike' : 'Like'}</div>
      ${playlistSection}
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="share">Copy Link</div>
    `;

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    // Position submenu to left if it would overflow right edge
    const subMenuEl = menu.querySelector('.context-submenu');
    if (subMenuEl) {
      const parentItem = subMenuEl.parentElement;
      parentItem.addEventListener('mouseenter', () => {
        const subRect = subMenuEl.getBoundingClientRect();
        if (subRect.right > window.innerWidth) {
          subMenuEl.classList.add('open-left');
        } else {
          subMenuEl.classList.remove('open-left');
        }
        if (subRect.bottom > window.innerHeight) {
          subMenuEl.style.top = 'auto';
          subMenuEl.style.bottom = '0';
        }
      });
    }

    menu.addEventListener('click', (ev) => {
      const item = ev.target.closest('[data-action]');
      if (!item) return;
      const action = item.dataset.action;
      if (action === 'none') return;
      switch (action) {
        case 'play': playTrack(track); break;
        case 'play-next':
          if (state.queueIndex >= 0) {
            state.queue.splice(state.queueIndex + 1, 0, track);
          } else {
            state.queue.push(track);
          }
          showToast('Added to play next');
          break;
        case 'add-queue':
          state.queue.push(track);
          showToast('Added to queue');
          break;
        case 'watch-video':
          openVideoPlayer(track.id, track.title, track.artist);
          break;
        case 'like': toggleLike(track); break;
        case 'add-to-playlist':
          addToPlaylist(item.dataset.pid, track);
          break;
        case 'share':
          navigator.clipboard.writeText(track.url || `https://music.youtube.com/watch?v=${track.id}`);
          showToast('Link copied to clipboard');
          break;
      }
      removeContextMenu();
    });

    setTimeout(() => {
      document.addEventListener('click', removeContextMenu, { once: true });
    }, 10);
  }

  function removeContextMenu() {
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
  }

  function showAlbumContextMenu(e, albumId, meta) {
    removeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    menu.innerHTML = `
      <div class="context-menu-item" data-action="play-all">Play All</div>
      <div class="context-menu-item" data-action="shuffle">Shuffle Play</div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="share">Copy Link</div>
    `;

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    menu.addEventListener('click', async (ev) => {
      const item = ev.target.closest('.context-menu-item');
      if (!item) return;
      switch (item.dataset.action) {
        case 'play-all': {
          const album = await window.snowify.albumTracks(albumId);
          if (album && album.tracks.length) playFromList(album.tracks, 0);
          else showToast('Could not load album');
          break;
        }
        case 'shuffle': {
          const album = await window.snowify.albumTracks(albumId);
          if (album && album.tracks.length) {
            const shuffled = [...album.tracks].sort(() => Math.random() - 0.5);
            playFromList(shuffled, 0);
          } else showToast('Could not load album');
          break;
        }
        case 'share':
          navigator.clipboard.writeText(`https://music.youtube.com/browse/${albumId}`);
          showToast('Link copied to clipboard');
          break;
      }
      removeContextMenu();
    });

    setTimeout(() => {
      document.addEventListener('click', removeContextMenu, { once: true });
    }, 10);
  }

  async function playTrack(track) {
    state.isLoading = true;
    updatePlayButton();
    showNowPlaying(track);
    showToast(`Loading: ${track.title}`);

    try {
      const directUrl = await window.snowify.getStreamUrl(track.url, state.audioQuality);
      audio.src = directUrl;
      audio.volume = state.volume * 0.3;
      audio.load();
      await audio.play();
      state.isPlaying = true;
      state.isLoading = false;
      addToRecent(track);
      updateDiscordPresence(track);
      saveState();
      prefetchNextTrack();
    } catch (err) {
      console.error('Playback error:', err);
      const msg = typeof err === 'string' ? err : (err.message || 'unknown error');
      showToast('Playback failed: ' + msg);
      state.isPlaying = false;
      state.isLoading = false;
      updatePlayButton();
      updateTrackHighlight();
      // Auto-advance to next track on failure (avoid infinite loop via flag)
      if (!playTrack._skipAdvance) {
        const nextIdx = state.queueIndex + 1;
        if (nextIdx < state.queue.length) {
          playTrack._skipAdvance = true;
          state.queueIndex = nextIdx;
          playTrack(state.queue[nextIdx]).finally(() => { playTrack._skipAdvance = false; });
          renderQueue();
        }
      }
      return;
    }
    updatePlayButton();
    updateTrackHighlight();
  }

  function prefetchNextTrack() {
    const nextIdx = state.queueIndex + 1;
    if (nextIdx >= state.queue.length) return;
    const next = state.queue[nextIdx];
    if (!next || !next.url && !next.id) return;
    const url = next.url || `https://music.youtube.com/watch?v=${next.id}`;
    // Fire-and-forget: this populates the main-process cache
    window.snowify.getStreamUrl(url, state.audioQuality).catch(() => {});
  }

  function playFromList(tracks, index) {
    state.originalQueue = [...tracks];
    if (state.shuffle) {
      const picked = tracks[index];
      const rest = tracks.filter((_, i) => i !== index);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      state.queue = [picked, ...rest];
      state.queueIndex = 0;
    } else {
      state.queue = [...tracks];
      state.queueIndex = index;
    }
    playTrack(state.queue[state.queueIndex]);
    renderQueue();
  }

  function playNext() {
    if (!state.queue.length) return;

    if (state.repeat === 'one') {
      audio.currentTime = 0;
      audio.play();
      state.isPlaying = true;
      updatePlayButton();
      return;
    }

    if (state.repeat === 'all') {
      let nextIdx = state.queueIndex + 1;
      if (nextIdx >= state.queue.length) nextIdx = 0;
      state.queueIndex = nextIdx;
      playTrack(state.queue[nextIdx]);
      renderQueue();
      return;
    }

    let nextIdx = state.queueIndex + 1;
    if (nextIdx >= state.queue.length) {
      if (state.autoplay) {
        smartQueueFill();
        return;
      }
      state.isPlaying = false;
      updatePlayButton();
      return;
    }
    state.queueIndex = nextIdx;
    playTrack(state.queue[nextIdx]);
    renderQueue();
  }

  async function smartQueueFill() {
    const current = state.queue[state.queueIndex];
    if (!current) return;

    showToast('Autoplay: finding similar songs...');

    try {
      const queueIds = new Set(state.queue.map(t => t.id));
      const seen = new Set();
      let pool = [];

      const addToPool = (tracks) => {
        tracks.forEach(t => {
          if (!queueIds.has(t.id) && !seen.has(t.id)) {
            seen.add(t.id);
            pool.push(t);
          }
        });
      };

      // 1. YouTube Music's "Up Next" — genre-aware recommendations from different artists
      const upNexts = await window.snowify.getUpNexts(current.id);
      addToPool(upNexts);

      // 2. Current artist's top songs as extra padding
      if (pool.length < 10 && current.artistId) {
        const info = await window.snowify.artistInfo(current.artistId);
        if (info) addToPool(info.topSongs || []);
      }

      if (!pool.length) {
        showToast('Autoplay: no similar songs found');
        state.isPlaying = false;
        updatePlayButton();
        return;
      }

      // Shuffle and take up to 20
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const maxAdd = Math.min(20, 200 - state.queue.length);
      if (maxAdd <= 0) {
        // Trim oldest played tracks to make room
        const trim = Math.min(state.queueIndex, state.queue.length - 100);
        if (trim > 0) {
          state.queue.splice(0, trim);
          state.queueIndex -= trim;
        }
      }
      const newTracks = pool.slice(0, Math.max(maxAdd, 10));

      state.queue.push(...newTracks);
      state.queueIndex++;
      playTrack(state.queue[state.queueIndex]);
      renderQueue();
      showToast(`Autoplay: added ${newTracks.length} songs`);
    } catch (err) {
      console.error('Autoplay error:', err);
      showToast('Autoplay failed');
      state.isPlaying = false;
      updatePlayButton();
    }
  }

  function playPrev() {
    if (!state.queue.length) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    let prevIdx = state.queueIndex - 1;
    if (prevIdx < 0) prevIdx = 0;
    state.queueIndex = prevIdx;
    playTrack(state.queue[prevIdx]);
    renderQueue();
  }

  // ─── Discord RPC helpers ───

  function updateDiscordPresence(track) {
    if (!state.discordRpc || !track) return;
    const startMs = Date.now() - Math.floor((audio.currentTime || 0) * 1000);
    const durationMs = track.durationMs || (audio.duration ? Math.round(audio.duration * 1000) : 0);
    const data = {
      title: track.title,
      artist: track.artist,
      thumbnail: track.thumbnail || '',
      startTimestamp: startMs
    };
    if (durationMs) {
      data.endTimestamp = startMs + durationMs;
    }
    window.snowify.updatePresence(data);
  }

  function clearDiscordPresence() {
    if (!state.discordRpc) return;
    window.snowify.clearPresence();
  }

  function togglePlay() {
    if (state.isLoading) return;
    if (!audio.src) return;
    if (audio.paused) {
      audio.play();
      state.isPlaying = true;
      const track = state.queue[state.queueIndex];
      if (track) updateDiscordPresence(track);
    } else {
      audio.pause();
      state.isPlaying = false;
      clearDiscordPresence();
    }
    updatePlayButton();
  }

  audio.addEventListener('ended', playNext);
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('seeked', () => {
    if (state.isPlaying) {
      const track = state.queue[state.queueIndex];
      if (track) updateDiscordPresence(track);
    }
  });
  audio.addEventListener('error', () => {
    state.isPlaying = false;
    state.isLoading = false;
    updatePlayButton();
    clearDiscordPresence();
    showToast('Audio error — skipping to next track');
    // Auto-advance on audio error
    const nextIdx = state.queueIndex + 1;
    if (nextIdx < state.queue.length) {
      state.queueIndex = nextIdx;
      playTrack(state.queue[nextIdx]);
      renderQueue();
    }
  });

  // ─── Playback watchdog ───
  let _watchdogLastTime = -1;
  let _watchdogStallTicks = 0;
  const _watchdogHandle = setInterval(() => {
    // Only check when we think we're playing
    if (!state.isPlaying || state.isLoading || audio.paused) {
      _watchdogLastTime = -1;
      _watchdogStallTicks = 0;
      return;
    }
    const ct = audio.currentTime;
    if (_watchdogLastTime >= 0 && ct === _watchdogLastTime && ct > 0) {
      _watchdogStallTicks++;
      // ~8 seconds stalled, audio is stuck
      if (_watchdogStallTicks >= 4) {
        console.warn('Watchdog: playback stalled at', ct, '— advancing');
        _watchdogStallTicks = 0;
        _watchdogLastTime = -1;
        showToast('Stream stalled — skipping to next');
        playNext();
      }
    } else {
      _watchdogStallTicks = 0;
    }
    _watchdogLastTime = ct;
  }, 2000);

  $('#btn-play-pause').addEventListener('click', togglePlay);
  $('#btn-next').addEventListener('click', playNext);
  $('#btn-prev').addEventListener('click', playPrev);

  const btnShuffle = $('#btn-shuffle');
  btnShuffle.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    btnShuffle.classList.toggle('active', state.shuffle);

    if (state.queue.length > 1) {
      const current = state.queue[state.queueIndex];
      if (state.shuffle) {
        state.originalQueue = [...state.queue];
        const rest = state.queue.filter((_, i) => i !== state.queueIndex);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        state.queue = [current, ...rest];
        state.queueIndex = 0;
      } else {
        const idx = state.originalQueue.findIndex(t => t.id === current.id);
        state.queue = [...state.originalQueue];
        state.queueIndex = idx >= 0 ? idx : 0;
      }
      renderQueue();
    }

    saveState();
  });

  const btnRepeat = $('#btn-repeat');
  btnRepeat.addEventListener('click', () => {
    const modes = ['off', 'all', 'one'];
    const i = (modes.indexOf(state.repeat) + 1) % modes.length;
    state.repeat = modes[i];
    btnRepeat.classList.toggle('active', state.repeat !== 'off');
    updateRepeatButton();
    saveState();
  });

  function updateRepeatButton() {
    if (state.repeat === 'one') {
      btnRepeat.title = 'Repeat One';
      btnRepeat.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/>
          <path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
          <text x="12" y="15" text-anchor="middle" font-size="8" fill="currentColor" stroke="none" font-weight="bold">1</text>
        </svg>`;
    } else if (state.repeat === 'all') {
      btnRepeat.title = 'Repeat All';
      btnRepeat.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/>
          <path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
          <text x="12" y="15" text-anchor="middle" font-size="7" fill="currentColor" stroke="none" font-weight="bold">∞</text>
        </svg>`;
    } else {
      btnRepeat.title = 'Repeat';
      btnRepeat.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/>
          <path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
        </svg>`;
    }
  }

  const progressBar = $('#progress-bar');
  const progressFill = $('#progress-fill');

  function updateProgress() {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    progressFill.style.width = pct + '%';
    $('#time-current').textContent = formatTime(audio.currentTime);
    $('#time-total').textContent = formatTime(audio.duration);
  }

  let isDraggingProgress = false;
  progressBar.addEventListener('mousedown', (e) => {
    isDraggingProgress = true;
    seekTo(e);
  });
  document.addEventListener('mousemove', (e) => {
    if (isDraggingProgress) seekTo(e);
  });
  document.addEventListener('mouseup', () => { isDraggingProgress = false; });

  function seekTo(e) {
    const rect = progressBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (audio.duration) {
      audio.currentTime = pct * audio.duration;
      progressFill.style.width = (pct * 100) + '%';
    }
  }

  const volumeSlider = $('#volume-slider');
  const volumeFill = $('#volume-fill');
  const btnVolume = $('#btn-volume');

  function setVolume(vol) {
    state.volume = Math.max(0, Math.min(1, vol));
    audio.volume = state.volume * 0.3;
    volumeFill.style.width = (state.volume * 100) + '%';
    const isMuted = state.volume === 0;
    $('.vol-icon', btnVolume).classList.toggle('hidden', isMuted);
    $('.vol-mute-icon', btnVolume).classList.toggle('hidden', !isMuted);
    saveState();
  }

  let isDraggingVolume = false;
  volumeSlider.addEventListener('mousedown', (e) => {
    isDraggingVolume = true;
    updateVolume(e);
  });
  document.addEventListener('mousemove', (e) => {
    if (isDraggingVolume) updateVolume(e);
  });
  document.addEventListener('mouseup', () => { isDraggingVolume = false; });

  function updateVolume(e) {
    const rect = volumeSlider.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setVolume(pct);
  }

  let prevVolume = 0.7;
  btnVolume.addEventListener('click', () => {
    if (state.volume > 0) {
      prevVolume = state.volume;
      setVolume(0);
    } else {
      setVolume(prevVolume);
    }
  });

  function showNowPlaying(track) {
    const bar = $('#now-playing-bar');
    bar.classList.remove('hidden');
    document.querySelector('#app').classList.remove('no-player');

    $('#np-thumbnail').src = track.thumbnail;
    const npTitle = $('#np-title');
    npTitle.textContent = track.title;
    if (track.albumId) {
      npTitle.classList.add('clickable');
      npTitle.onclick = () => showAlbumDetail(track.albumId, { name: track.album, thumbnail: track.thumbnail });
    } else {
      npTitle.classList.remove('clickable');
      npTitle.onclick = null;
    }

    const npArtist = $('#np-artist');
    npArtist.innerHTML = renderArtistLinks(track);
    npArtist.classList.remove('clickable');
    npArtist.onclick = null;
    bindArtistLinks(npArtist);

    const isLiked = state.likedSongs.some(t => t.id === track.id);
    $('#np-like').classList.toggle('liked', isLiked);

    updateMediaSession(track);
    onTrackChanged(track);
  }

  function updatePlayButton() {
    const playIcon = $('.icon-play', $('#btn-play-pause'));
    const pauseIcon = $('.icon-pause', $('#btn-play-pause'));
    if (state.isPlaying) {
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
    } else {
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
    }
  }

  function updateTrackHighlight() {
    $$('.track-row').forEach(row => {
      const current = state.queue[state.queueIndex];
      row.classList.toggle('playing', current && row.dataset.trackId === current.id);
    });
  }

  function updateMediaSession(track) {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        artwork: [{ src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' }]
      });
      navigator.mediaSession.setActionHandler('play', () => { audio.play(); state.isPlaying = true; updatePlayButton(); updateDiscordPresence(track); });
      navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); state.isPlaying = false; updatePlayButton(); clearDiscordPresence(); });
      navigator.mediaSession.setActionHandler('previoustrack', playPrev);
      navigator.mediaSession.setActionHandler('nexttrack', playNext);
    }
  }

  const npLike = $('#np-like');
  npLike.addEventListener('click', () => {
    const track = state.queue[state.queueIndex];
    if (track) {
      const wasLiked = toggleLike(track);
      if (wasLiked) spawnHeartParticles(npLike);
    }
  });

  function toggleLike(track) {
    const idx = state.likedSongs.findIndex(t => t.id === track.id);
    if (idx >= 0) {
      state.likedSongs.splice(idx, 1);
      showToast('Removed from Liked Songs');
    } else {
      state.likedSongs.push(track);
      showToast('Added to Liked Songs');
    }
    saveState();
    updateLikedCount();
    const current = state.queue[state.queueIndex];
    if (current?.id === track.id) {
      npLike.classList.toggle('liked', state.likedSongs.some(t => t.id === track.id));
    }
    // Return true if the track was liked (not unliked)
    return idx < 0;
  }

  function spawnHeartParticles(originEl) {
    const rect = originEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const count = 7;
    for (let i = 0; i < count; i++) {
      const heart = document.createElement('div');
      heart.className = 'heart-particle';
      heart.textContent = '\u2764';
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
      const dist = 20 + Math.random() * 25;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist - 15;
      const scale = 0.6 + Math.random() * 0.5;
      heart.style.left = cx + 'px';
      heart.style.top = cy + 'px';
      heart.style.setProperty('--dx', dx + 'px');
      heart.style.setProperty('--dy', dy + 'px');
      heart.style.setProperty('--s', scale);
      document.body.appendChild(heart);
      heart.addEventListener('animationend', () => heart.remove());
    }
  }

  function updateLikedCount() {
    const el = document.querySelector('[data-playlist="liked"] .playlist-count');
    if (el) el.textContent = `${state.likedSongs.length} song${state.likedSongs.length !== 1 ? 's' : ''}`;
  }

  function createPlaylist(name) {
    const id = 'pl_' + Date.now();
    const playlist = { id, name: name || `My Playlist #${state.playlists.length + 1}`, tracks: [] };
    state.playlists.push(playlist);
    saveState();
    renderPlaylists();
    showToast(`Created "${playlist.name}"`);
    return playlist;
  }

  function getPlaylistCoverHtml(playlist, size = 'normal') {
    const sizeClass = size === 'large' ? ' playlist-cover-lg' : '';
    if (playlist.coverImage) {
      return `<img src="file://${encodeURI(playlist.coverImage)}" alt="" />`;
    }
    if (playlist.tracks.length >= 4) {
      const thumbs = playlist.tracks.slice(0, 4).map(t => t.thumbnail);
      return `<div class="playlist-cover-grid${sizeClass}">${thumbs.map(t => `<img src="${escapeHtml(t)}" alt="" />`).join('')}</div>`;
    }
    if (playlist.tracks.length > 0) {
      return `<img src="${escapeHtml(playlist.tracks[0].thumbnail)}" alt="" />`;
    }
    const iconSize = size === 'large' ? 64 : size === 'lib' ? 32 : 20;
    return `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="#535353"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
  }

  async function changePlaylistCover(playlist) {
    const filePath = await window.snowify.pickImage();
    if (!filePath) return;
    // Delete old custom cover if exists
    if (playlist.coverImage) {
      await window.snowify.deleteImage(playlist.coverImage);
    }
    const savedPath = await window.snowify.saveImage(playlist.id, filePath);
    if (savedPath) {
      playlist.coverImage = savedPath;
      saveState();
      renderPlaylists();
      showToast('Cover image updated');
      // Re-render detail if we're viewing this playlist
      if (state.currentPlaylistId === playlist.id) {
        showPlaylistDetail(playlist, false);
      }
    } else {
      showToast('Failed to save image');
    }
  }

  async function removePlaylistCover(playlist) {
    if (playlist.coverImage) {
      await window.snowify.deleteImage(playlist.coverImage);
      delete playlist.coverImage;
      saveState();
      renderPlaylists();
      showToast('Cover image removed');
      if (state.currentPlaylistId === playlist.id) {
        showPlaylistDetail(playlist, false);
      }
    }
  }

  function addToPlaylist(playlistId, track) {
    const pl = state.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    if (pl.tracks.some(t => t.id === track.id)) {
      showToast('Already in this playlist');
      return;
    }
    pl.tracks.push(track);
    saveState();
    renderPlaylists();
    showToast(`Added to "${pl.name}"`);
  }

  function renderPlaylists() {
    const container = $('#playlist-list');
    let html = `
      <div class="playlist-item" data-playlist="liked">
        <div class="playlist-cover liked-cover">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        </div>
        <div class="playlist-info">
          <span class="playlist-name">Liked Songs</span>
          <span class="playlist-count">${state.likedSongs.length} song${state.likedSongs.length !== 1 ? 's' : ''}</span>
        </div>
      </div>`;

    state.playlists.forEach(pl => {
      html += `
        <div class="playlist-item" data-playlist="${pl.id}">
          <div class="playlist-cover">
            ${getPlaylistCoverHtml(pl, 'normal')}
          </div>
          <div class="playlist-info">
            <span class="playlist-name">${escapeHtml(pl.name)}</span>
            <span class="playlist-count">${pl.tracks.length} song${pl.tracks.length !== 1 ? 's' : ''}</span>
          </div>
        </div>`;
    });

    container.innerHTML = html;
    container.querySelectorAll('.playlist-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (_dragActive) return;
        const pid = item.dataset.playlist;
        if (pid === 'liked') {
          showPlaylistDetail({ id: 'liked', name: 'Liked Songs', tracks: state.likedSongs }, true);
        } else {
          const pl = state.playlists.find(p => p.id === pid);
          if (pl) showPlaylistDetail(pl, false);
        }
      });

      // Right-click context menu for playlists in sidebar
      if (item.dataset.playlist !== 'liked') {
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const pl = state.playlists.find(p => p.id === item.dataset.playlist);
          if (!pl) return;
          showSidebarPlaylistMenu(e, pl);
        });
      }

      // Drop target for drag-and-drop
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        item.classList.add('drag-over');
      });
      item.addEventListener('dragenter', (e) => {
        e.preventDefault();
        item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over');
      });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        handleTrackDrop(e, item.dataset.playlist);
      });
    });
  }

  function showSidebarPlaylistMenu(e, playlist) {
    removeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    menu.innerHTML = `
      <div class="context-menu-item" data-action="play">Play</div>
      <div class="context-menu-item" data-action="shuffle">Shuffle play</div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="change-cover">Change cover</div>
      ${playlist.coverImage ? '<div class="context-menu-item" data-action="remove-cover">Remove cover</div>' : ''}
      <div class="context-menu-item" data-action="rename">Rename</div>
      <div class="context-menu-item" data-action="delete" style="color:var(--red)">Delete</div>
    `;

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    menu.addEventListener('click', async (ev) => {
      const item = ev.target.closest('.context-menu-item');
      if (!item) return;
      switch (item.dataset.action) {
        case 'play':
          if (playlist.tracks.length) playFromList(playlist.tracks, 0);
          else showToast('Playlist is empty');
          break;
        case 'shuffle':
          if (playlist.tracks.length) {
            const shuffled = [...playlist.tracks];
            for (let i = shuffled.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            playFromList(shuffled, 0);
          } else showToast('Playlist is empty');
          break;
        case 'rename': {
          removeContextMenu();
          const newName = await showInputModal('Rename playlist', playlist.name);
          if (newName && newName !== playlist.name) {
            playlist.name = newName;
            saveState();
            renderPlaylists();
            showToast(`Renamed to "${playlist.name}"`);
          }
          return;
        }
        case 'change-cover': {
          removeContextMenu();
          await changePlaylistCover(playlist);
          return;
        }
        case 'remove-cover': {
          removeContextMenu();
          await removePlaylistCover(playlist);
          return;
        }
        case 'delete':
          if (confirm(`Delete "${playlist.name}"?`)) {
            if (playlist.coverImage) window.snowify.deleteImage(playlist.coverImage);
            state.playlists = state.playlists.filter(p => p.id !== playlist.id);
            saveState();
            renderPlaylists();
            if (state.currentPlaylistId === playlist.id) switchView('library');
            showToast(`Deleted "${playlist.name}"`);
          }
          break;
      }
      removeContextMenu();
    });

    setTimeout(() => {
      document.addEventListener('click', removeContextMenu, { once: true });
    }, 10);
  }

  function showPlaylistDetail(playlist, isLiked) {
    state.currentPlaylistId = playlist.id;
    switchView('playlist');

    const heroName = $('#playlist-hero-name');
    const heroCount = $('#playlist-hero-count');
    const heroCover = $('#playlist-hero-cover');
    const tracksContainer = $('#playlist-tracks');

    heroName.textContent = playlist.name;
    heroCount.textContent = `${playlist.tracks.length} song${playlist.tracks.length !== 1 ? 's' : ''}`;

    if (isLiked) {
      heroCover.innerHTML = `<svg width="64" height="64" viewBox="0 0 24 24" fill="#fff"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
      heroCover.style.background = 'linear-gradient(135deg, #450af5, #c4efd9)';
    } else {
      const coverContent = getPlaylistCoverHtml(playlist, 'large');
      const hasCover = playlist.coverImage || playlist.tracks.length > 0;
      heroCover.innerHTML = coverContent;
      heroCover.style.background = hasCover ? '' : 'linear-gradient(135deg, #450af5, #8e2de2)';
    }

    // Hide rename/delete/cover for Liked Songs
    const renameBtn = $('#btn-rename-playlist');
    const deleteBtn = $('#btn-delete-playlist');
    const coverBtn = $('#btn-cover-playlist');
    renameBtn.style.display = isLiked ? 'none' : '';
    deleteBtn.style.display = isLiked ? 'none' : '';
    coverBtn.style.display = isLiked ? 'none' : '';

    if (playlist.tracks.length) {
      renderTrackList(tracksContainer, playlist.tracks, 'playlist');

      // Add remove-from-playlist to right-click
      tracksContainer.querySelectorAll('.track-row').forEach(row => {
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const idx = parseInt(row.dataset.index);
          const track = playlist.tracks[idx];
          showPlaylistTrackMenu(e, track, playlist, isLiked, idx);
        });
      });
    } else {
      tracksContainer.innerHTML = `
        <div class="empty-state">
          <p>This playlist is empty</p>
          <p>Find songs you like and add them here</p>
        </div>`;
    }

    $('#btn-play-all').onclick = () => {
      if (playlist.tracks.length) playFromList(playlist.tracks, 0);
    };

    $('#btn-shuffle-playlist').onclick = () => {
      if (playlist.tracks.length) {
        const shuffled = [...playlist.tracks];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        playFromList(shuffled, 0);
      }
    };

    renameBtn.onclick = async () => {
      if (isLiked) return;
      const newName = await showInputModal('Rename playlist', playlist.name);
      if (newName && newName !== playlist.name) {
        playlist.name = newName;
        saveState();
        heroName.textContent = playlist.name;
        renderPlaylists();
        showToast(`Renamed to "${playlist.name}"`);
      }
    };

    coverBtn.onclick = async () => {
      if (isLiked) return;
      await changePlaylistCover(playlist);
    };

    deleteBtn.onclick = () => {
      if (isLiked) return;
      if (confirm(`Delete "${playlist.name}"?\nThis cannot be undone.`)) {
        if (playlist.coverImage) window.snowify.deleteImage(playlist.coverImage);
        state.playlists = state.playlists.filter(p => p.id !== playlist.id);
        saveState();
        renderPlaylists();
        switchView('library');
        showToast(`Deleted "${playlist.name}"`);
      }
    };
  }

  function showPlaylistTrackMenu(e, track, playlist, isLiked, idx) {
    removeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    const liked = state.likedSongs.some(t => t.id === track.id);

    menu.innerHTML = `
      <div class="context-menu-item" data-action="play">Play</div>
      <div class="context-menu-item" data-action="play-next">Play Next</div>
      <div class="context-menu-item" data-action="add-queue">Add to Queue</div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="like">${liked ? 'Unlike' : 'Like'}</div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="remove">Remove from ${isLiked ? 'Liked Songs' : 'playlist'}</div>
      ${!isLiked && idx > 0 ? '<div class="context-menu-item" data-action="move-up">Move up</div>' : ''}
      ${!isLiked && idx < playlist.tracks.length - 1 ? '<div class="context-menu-item" data-action="move-down">Move down</div>' : ''}
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="share">Copy Link</div>
    `;

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    menu.addEventListener('click', (ev) => {
      const item = ev.target.closest('.context-menu-item');
      if (!item) return;
      const action = item.dataset.action;
      switch (action) {
        case 'play': playTrack(track); break;
        case 'play-next':
          if (state.queueIndex >= 0) state.queue.splice(state.queueIndex + 1, 0, track);
          else state.queue.push(track);
          showToast('Added to play next');
          break;
        case 'add-queue': state.queue.push(track); showToast('Added to queue'); break;
        case 'like': toggleLike(track); break;
        case 'remove':
          if (isLiked) {
            state.likedSongs = state.likedSongs.filter(t => t.id !== track.id);
            saveState();
            updateLikedCount();
            showPlaylistDetail({ id: 'liked', name: 'Liked Songs', tracks: state.likedSongs }, true);
            showToast('Removed from Liked Songs');
          } else {
            playlist.tracks.splice(idx, 1);
            saveState();
            renderPlaylists();
            showPlaylistDetail(playlist, false);
            showToast('Removed from playlist');
          }
          break;
        case 'move-up':
          [playlist.tracks[idx - 1], playlist.tracks[idx]] = [playlist.tracks[idx], playlist.tracks[idx - 1]];
          saveState();
          showPlaylistDetail(playlist, false);
          break;
        case 'move-down':
          [playlist.tracks[idx], playlist.tracks[idx + 1]] = [playlist.tracks[idx + 1], playlist.tracks[idx]];
          saveState();
          showPlaylistDetail(playlist, false);
          break;
        case 'share':
          navigator.clipboard.writeText(track.url || `https://music.youtube.com/watch?v=${track.id}`);
          showToast('Link copied to clipboard');
          break;
      }
      removeContextMenu();
    });

    setTimeout(() => {
      document.addEventListener('click', removeContextMenu, { once: true });
    }, 10);
  }

  $('#btn-create-playlist').addEventListener('click', async () => {
    const name = await showInputModal('Create playlist', 'My Playlist');
    if (name) createPlaylist(name);
  });
  $('#btn-lib-create-playlist')?.addEventListener('click', async () => {
    const name = await showInputModal('Create playlist', 'My Playlist');
    if (name) createPlaylist(name);
  });
  $('#btn-spotify-import').addEventListener('click', () => openSpotifyImport());

  function renderLibrary() {
    const container = $('#library-content');
    const allPlaylists = [
      { id: 'liked', name: 'Liked Songs', tracks: state.likedSongs, isLiked: true },
      ...state.playlists.map(p => ({ ...p, isLiked: false }))
    ];

    if (!allPlaylists.some(p => p.tracks.length) && state.playlists.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="#535353"><path d="M4 4h2v16H4V4zm5 0h2v16H9V4zm5 2h2v14h-2V6zm5-2h2v16h-2V4z"/></svg>
          <h3>Create your first playlist</h3>
          <p>It\u2019s easy \u2014 we\u2019ll help you</p>
          <button class="btn-primary" id="btn-lib-create-playlist-2">Create playlist</button>
        </div>`;
      $('#btn-lib-create-playlist-2')?.addEventListener('click', async () => {
        const name = await showInputModal('Create playlist', 'My Playlist');
        if (name) { createPlaylist(name); renderLibrary(); }
      });
      return;
    }

    container.innerHTML = `<div class="library-grid">${allPlaylists.map(p => {
      const coverHtml = p.isLiked
        ? `<div class="lib-card-cover liked-cover"><svg width="32" height="32" viewBox="0 0 24 24" fill="#fff"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></div>`
        : `<div class="lib-card-cover">${getPlaylistCoverHtml(p, 'lib')}</div>`;
      return `
        <div class="lib-card" data-playlist="${p.id}">
          ${coverHtml}
          <div class="lib-card-name">${escapeHtml(p.name)}</div>
          <div class="lib-card-meta">Playlist \u00b7 ${p.tracks.length} song${p.tracks.length !== 1 ? 's' : ''}</div>
        </div>`;
    }).join('')}</div>`;

    container.querySelectorAll('.lib-card').forEach(card => {
      card.addEventListener('click', () => {
        const pid = card.dataset.playlist;
        if (pid === 'liked') {
          showPlaylistDetail({ id: 'liked', name: 'Liked Songs', tracks: state.likedSongs }, true);
        } else {
          const pl = state.playlists.find(p => p.id === pid);
          if (pl) showPlaylistDetail(pl, false);
        }
      });
    });
  }

  const queuePanel = $('#queue-panel');

  $('#btn-queue').addEventListener('click', () => {
    queuePanel.classList.toggle('hidden');
    queuePanel.classList.toggle('visible');
    renderQueue();
  });
  $('#btn-close-queue').addEventListener('click', () => {
    queuePanel.classList.add('hidden');
    queuePanel.classList.remove('visible');
  });

  function renderQueue() {
    const nowPlaying = $('#queue-now-playing');
    const upNext = $('#queue-up-next');

    const current = state.queue[state.queueIndex];
    if (current) {
      nowPlaying.innerHTML = renderQueueItem(current, true);
    } else {
      nowPlaying.innerHTML = `<p style="color:var(--text-subdued);font-size:13px;">Nothing playing</p>`;
    }

    const upcoming = state.queue.slice(state.queueIndex + 1);
    if (upcoming.length) {
      upNext.innerHTML = upcoming.map(t => renderQueueItem(t, false)).join('');
    } else {
      upNext.innerHTML = `<p style="color:var(--text-subdued);font-size:13px;">Queue is empty</p>`;
    }

    // Right-click + drag on all queue items
    const allQueueItems = $$('.queue-item[data-track-id]', document.getElementById('queue-panel'));
    allQueueItems.forEach(item => {
      const track = state.queue.find(t => t.id === item.dataset.trackId);
      if (!track) return;
      bindArtistLinks(item);
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e, track);
      });
      item.addEventListener('dragstart', (e) => {
        startTrackDrag(e, track);
      });
    });
  }

  function renderQueueItem(track, isActive) {
    return `
      <div class="queue-item ${isActive ? 'active' : ''}" data-track-id="${track.id}" draggable="true">
        <img src="${escapeHtml(track.thumbnail)}" alt="" />
        <div class="queue-item-info">
          <div class="queue-item-title">${escapeHtml(track.title)}</div>
          <div class="queue-item-artist">${renderArtistLinks(track)}</div>
        </div>
      </div>`;
  }

  function addToRecent(track) {
    state.recentTracks = state.recentTracks.filter(t => t.id !== track.id);
    state.recentTracks.unshift(track);
    if (state.recentTracks.length > 20) state.recentTracks.pop();
    saveState();
    // Only update the lightweight parts — skip expensive API calls
    renderRecentTracks();
    renderQuickPicks();
  }

  async function renderHome() {
    // Backfill missing artistIds in recent tracks
    const needsId = state.recentTracks.filter(t => t.artist && !t.artistId);
    if (needsId.length) {
      const uniqueNames = [...new Set(needsId.map(t => t.artist))];
      const lookups = await Promise.all(uniqueNames.map(n => window.snowify.searchArtists(n).catch(() => [])));
      const nameToId = {};
      uniqueNames.forEach((name, i) => {
        if (lookups[i]?.length) nameToId[name] = lookups[i][0].artistId;
      });
      let changed = false;
      state.recentTracks.forEach(t => {
        if (!t.artistId && nameToId[t.artist]) { t.artistId = nameToId[t.artist]; changed = true; }
      });
      if (changed) saveState();
    }
    renderRecentTracks();
    renderQuickPicks();
    renderNewReleases();
    renderRecommendations();
  }

  let _lastReleaseFetch = 0;
  let _cachedReleases = null;

  async function renderNewReleases() {
    const section = $('#new-releases-section');
    const container = $('#new-releases');

    if (!state.followedArtists.length) {
      section.style.display = 'none';
      return;
    }

    const now = Date.now();
    const currentYear = new Date().getFullYear();

    // Use cache if fetched within last 30 min
    if (_cachedReleases && now - _lastReleaseFetch < 30 * 60 * 1000) {
      if (_cachedReleases.length) {
        section.style.display = '';
        renderReleaseCards(container, _cachedReleases);
      } else {
        section.style.display = 'none';
      }
      return;
    }

    section.style.display = '';
    container.innerHTML = `<div class="loading" style="padding:20px"><div class="spinner"></div></div>`;

    try {
      const results = await Promise.allSettled(
        state.followedArtists.map(a => window.snowify.artistInfo(a.artistId))
      );

      const seen = new Set();
      const releases = [];

      results.forEach((r, i) => {
        if (r.status !== 'fulfilled' || !r.value) return;
        const info = r.value;
        const followedArtistId = state.followedArtists[i].artistId;
        const all = [...(info.topAlbums || []), ...(info.topSingles || [])];
        all.forEach(rel => {
          if (rel.year >= currentYear && !seen.has(rel.albumId)) {
            seen.add(rel.albumId);
            releases.push({ ...rel, artistName: info.name, artistId: followedArtistId });
          }
        });
      });

      releases.sort((a, b) => (b.year || 0) - (a.year || 0));
      _cachedReleases = releases;
      _lastReleaseFetch = now;

      if (releases.length) {
        renderReleaseCards(container, releases);
      } else {
        section.style.display = 'none';
      }
    } catch (err) {
      console.error('New releases error:', err);
      section.style.display = 'none';
    }
  }

  function renderReleaseCards(container, releases) {
    addScrollArrows(container);
    container.innerHTML = releases.map(a => `
      <div class="album-card" data-album-id="${a.albumId}">
        <img class="album-card-cover" src="${escapeHtml(a.thumbnail)}" alt="" loading="lazy" />
        <button class="album-card-play" title="Play">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
        </button>
        <div class="album-card-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
        <div class="album-card-meta">${a.artistId ? `<span class="album-card-artist clickable" data-artist-id="${escapeHtml(a.artistId)}">${escapeHtml(a.artistName || '')}</span>` : escapeHtml(a.artistName || '')}${a.year ? ' \u00B7 ' + a.year : ''}${a.type ? ' \u00B7 ' + a.type : ''}</div>
      </div>
    `).join('');

    container.querySelectorAll('.album-card').forEach(card => {
      const albumId = card.dataset.albumId;
      const meta = releases.find(a => a.albumId === albumId);
      card.querySelector('.album-card-play').addEventListener('click', async (e) => {
        e.stopPropagation();
        const album = await window.snowify.albumTracks(albumId);
        if (album && album.tracks.length) playFromList(album.tracks, 0);
      });
      card.querySelector('.album-card-artist.clickable')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openArtistPage(e.currentTarget.dataset.artistId);
      });
      card.addEventListener('click', () => showAlbumDetail(albumId, meta));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showAlbumContextMenu(e, albumId, meta);
      });
    });
  }

  function renderRecentTracks() {
    const container = $('#recent-tracks');
    if (!state.recentTracks.length) {
      container.innerHTML = `
        <div class="empty-state">
          <p>Your recently played tracks will show up here.</p>
          <p>Start by searching for something!</p>
        </div>`;
      return;
    }

    container.innerHTML = state.recentTracks.slice(0, 8).map(track => `
      <div class="track-card" data-track-id="${track.id}" draggable="true">
        <img class="card-thumb" src="${escapeHtml(track.thumbnail)}" alt="" loading="lazy" />
        <div class="card-title">${escapeHtml(track.title)}</div>
        <div class="card-artist">${renderArtistLinks(track)}</div>
        <button class="card-play" title="Play">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
        </button>
      </div>
    `).join('');

    container.querySelectorAll('.track-card').forEach(card => {
      card.addEventListener('click', () => {
        const track = state.recentTracks.find(t => t.id === card.dataset.trackId);
        if (track) playFromList([track], 0);
      });
      bindArtistLinks(card);
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const track = state.recentTracks.find(t => t.id === card.dataset.trackId);
        if (track) showContextMenu(e, track);
      });
      card.addEventListener('dragstart', (e) => {
        const track = state.recentTracks.find(t => t.id === card.dataset.trackId);
        if (track) startTrackDrag(e, track);
      });
    });
  }

  function renderQuickPicks() {
    const container = $('#quick-picks');
    const picks = state.recentTracks.slice(0, 6);
    if (!picks.length) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = picks.map(track => `
      <div class="quick-pick-card" data-track-id="${track.id}" draggable="true">
        <img src="${escapeHtml(track.thumbnail)}" alt="" />
        <span>${escapeHtml(track.title)}</span>
        <button class="qp-play" title="Play">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
        </button>
      </div>
    `).join('');

    container.querySelectorAll('.quick-pick-card').forEach(card => {
      card.addEventListener('click', () => {
        const track = state.recentTracks.find(t => t.id === card.dataset.trackId);
        if (track) playFromList([track], 0);
      });
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const track = state.recentTracks.find(t => t.id === card.dataset.trackId);
        if (track) showContextMenu(e, track);
      });
      card.addEventListener('dragstart', (e) => {
        const track = state.recentTracks.find(t => t.id === card.dataset.trackId);
        if (track) startTrackDrag(e, track);
      });
    });
  }

  async function renderRecommendations() {
    const songsSection = $('#recommended-songs-section');
    const songsContainer = $('#recommended-songs');

    // Gather artist play counts from recent + liked
    const allTracks = [...state.recentTracks, ...state.likedSongs];
    if (!allTracks.length) {
      songsSection.style.display = 'none';
      return;
    }

    const artistCounts = {};
    allTracks.forEach(t => {
      const trackArtists = t.artists?.length ? t.artists : (t.artistId ? [{ name: t.artist, id: t.artistId }] : []);
      trackArtists.forEach(a => {
        if (a.id) {
          if (!artistCounts[a.id]) artistCounts[a.id] = { name: a.name, artistId: a.id, count: 0 };
          artistCounts[a.id].count++;
        }
      });
    });

    const topArtists = Object.values(artistCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    if (!topArtists.length) return;

    // Fetch artist info for the top listened artists
    const knownTrackIds = new Set(allTracks.map(t => t.id));
    const recommendedSongs = [];

    const results = await Promise.allSettled(
      topArtists.map(a => window.snowify.artistInfo(a.artistId))
    );

    results.forEach(r => {
      if (r.status !== 'fulfilled' || !r.value) return;
      const info = r.value;

      // Songs: pick tracks user hasn't played yet
      (info.topSongs || []).forEach(song => {
        if (!knownTrackIds.has(song.id) && recommendedSongs.length < 8) {
          recommendedSongs.push(song);
          knownTrackIds.add(song.id);
        }
      });
    });

    // Render recommended songs
    if (recommendedSongs.length) {
      songsSection.style.display = '';
      songsContainer.innerHTML = recommendedSongs.map(track => `
        <div class="track-card" data-track-id="${track.id}" draggable="true">
          <img class="card-thumb" src="${escapeHtml(track.thumbnail)}" alt="" loading="lazy" />
          <div class="card-title">${escapeHtml(track.title)}</div>
          <div class="card-artist">${renderArtistLinks(track)}</div>
          <button class="card-play" title="Play">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
          </button>
        </div>
      `).join('');

      songsContainer.querySelectorAll('.track-card').forEach(card => {
        card.addEventListener('click', () => {
          const track = recommendedSongs.find(t => t.id === card.dataset.trackId);
          if (track) playFromList([track], 0);
        });
        bindArtistLinks(card);
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const track = recommendedSongs.find(t => t.id === card.dataset.trackId);
          if (track) showContextMenu(e, track);
        });
        card.addEventListener('dragstart', (e) => {
          const track = recommendedSongs.find(t => t.id === card.dataset.trackId);
          if (track) startTrackDrag(e, track);
        });
      });
    } else {
      songsSection.style.display = 'none';
    }
  }

  // ─── Explore ───

  let _exploreCache = null;
  let _chartsCache = null;
  let _exploreCacheTime = 0;
  let _chartsCacheTime = 0;
  const EXPLORE_CACHE_TTL = 30 * 60 * 1000;

  async function fetchExploreData() {
    const now = Date.now();
    if (_exploreCache && now - _exploreCacheTime < EXPLORE_CACHE_TTL) return _exploreCache;
    _exploreCache = await window.snowify.explore();
    _exploreCacheTime = now;
    return _exploreCache;
  }

  async function fetchChartsData() {
    const now = Date.now();
    if (_chartsCache && now - _chartsCacheTime < EXPLORE_CACHE_TTL) return _chartsCache;
    _chartsCache = await window.snowify.charts();
    _chartsCacheTime = now;
    return _chartsCache;
  }

  const MOOD_COLORS = [
    '#1db954', '#e13300', '#8c67ab', '#e8115b', '#1e90ff',
    '#f59b23', '#158a43', '#ba55d3', '#e05050', '#509bf5',
    '#ff6437', '#7358ff', '#27856a', '#e91e63', '#1db4e8',
    '#af2896', '#148a08', '#dc5b2e', '#5080ff', '#d84000',
  ];

  const POPULAR_MOODS = new Set([
    'pop', 'hip-hop', 'r&b', 'rock', 'chill', 'workout', 'party',
    'focus', 'romance', 'sad', 'feel good', 'jazz', 'classical',
    'country', 'electronic', 'indie', 'sleep', 'energy booster',
    'commute', 'latin', 'k-pop', 'metal',
  ]);

  async function renderExplore() {
    const content = $('#explore-content');
    content.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;

    // Apply country before fetching
    await window.snowify.setCountry(state.country || '');

    // Fetch both data sources in parallel
    const [exploreData, chartsData] = await Promise.all([
      fetchExploreData(),
      fetchChartsData()
    ]);

    if (!exploreData && !chartsData) {
      content.innerHTML = `<div class="empty-state"><p>Could not load explore data.</p></div>`;
      return;
    }

    let html = '';

    // Country hint banner
    if (!state.country) {
      html += `<div class="explore-country-hint">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
        <span>Set your <a href="#" id="explore-country-link">country in Settings</a> for more relevant recommendations</span>
      </div>`;
    }

    // ── New Albums & Singles ──
    if (exploreData?.newAlbums?.length) {
      html += `<div class="explore-section"><h2>New Albums & Singles</h2><div class="scroll-container"><button class="scroll-arrow scroll-arrow-left" data-dir="left"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button><div class="album-scroll">`;
      html += exploreData.newAlbums.map(a => `
        <div class="album-card" data-album-id="${escapeHtml(a.albumId)}">
          <img class="album-card-cover" src="${escapeHtml(a.thumbnail)}" alt="" loading="lazy" />
          <button class="album-card-play" title="Play">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
          </button>
          <div class="album-card-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
          <div class="album-card-meta">${renderArtistLinks(a)}</div>
        </div>
      `).join('');
      html += `</div><button class="scroll-arrow scroll-arrow-right" data-dir="right"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button></div></div>`;
    }

    // ── Trending (from charts) ──
    if (chartsData?.topSongs?.length) {
      html += `<div class="explore-section"><h2>Trending</h2><div class="top-songs-grid">`;
      html += chartsData.topSongs.map((track, i) => `
        <div class="top-song-item" data-track-id="${escapeHtml(track.id)}">
          <div class="top-song-rank">${track.rank || i + 1}</div>
          <div class="top-song-thumb-wrap">
            <img class="top-song-thumb" src="${escapeHtml(track.thumbnail)}" alt="" loading="lazy" />
            <div class="top-song-play"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg></div>
          </div>
          <div class="top-song-info">
            <div class="top-song-title">${escapeHtml(track.title)}</div>
            <div class="top-song-artist">${renderArtistLinks(track)}</div>
          </div>
        </div>
      `).join('');
      html += `</div></div>`;
    }

    // ── Top Artists (from charts) ──
    if (chartsData?.topArtists?.length) {
      html += `<div class="explore-section"><h2>Top Artists</h2><div class="scroll-container"><button class="scroll-arrow scroll-arrow-left" data-dir="left"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button><div class="album-scroll top-artists-scroll">`;
      html += chartsData.topArtists.map((a, i) => `
        <div class="top-artist-card" data-artist-id="${escapeHtml(a.artistId)}">
          <img class="top-artist-avatar" src="${escapeHtml(a.thumbnail)}" alt="" loading="lazy" />
          <div class="top-artist-name">${escapeHtml(a.name)}</div>
          <div class="top-artist-rank">#${i + 1}</div>
        </div>
      `).join('');
      html += `</div><button class="scroll-arrow scroll-arrow-right" data-dir="right"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button></div></div>`;
    }

    // ── New Music Videos ──
    if (exploreData?.newMusicVideos?.length) {
      html += `<div class="explore-section"><h2>New Music Videos</h2><div class="scroll-container"><button class="scroll-arrow scroll-arrow-left" data-dir="left"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button><div class="album-scroll music-video-scroll">`;
      html += exploreData.newMusicVideos.slice(0, 15).map(v => `
        <div class="video-card" data-video-id="${escapeHtml(v.id)}">
          <img class="video-card-thumb" src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy" />
          <button class="video-card-play" title="Watch">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
          </button>
          <div class="video-card-name" title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</div>
          <div class="video-card-duration">${renderArtistLinks(v)}</div>
        </div>
      `).join('');
      html += `</div><button class="scroll-arrow scroll-arrow-right" data-dir="right"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button></div></div>`;
    }

    // ── Moods & Genres ──
    if (exploreData?.moods?.length) {
      const filteredMoods = exploreData.moods.filter(m => POPULAR_MOODS.has(m.label.toLowerCase()));
      const displayMoods = filteredMoods.length ? filteredMoods : exploreData.moods.slice(0, 16);
      html += `<div class="explore-section" id="explore-moods-section"><h2>Moods & Genres</h2><div class="mood-grid">`;
      html += displayMoods.map((m, i) => {
        const bg = MOOD_COLORS[i % MOOD_COLORS.length];
        return `<div class="mood-card" data-browse-id="${escapeHtml(m.browseId)}" data-params="${escapeHtml(m.params || '')}" style="border-left-color:${bg}">${escapeHtml(m.label)}</div>`;
      }).join('');
      html += `</div></div>`;
    }

    content.innerHTML = html || `<div class="empty-state"><p>No explore data available.</p></div>`;

    // ── Attach listeners ──
    // Country hint link
    $('#explore-country-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      switchView('settings');
      setTimeout(() => $('#setting-country')?.focus(), 100);
    });

    attachExploreAlbumListeners(content, exploreData?.newAlbums || []);

    // Top songs
    const topSongsList = chartsData?.topSongs || [];
    content.querySelectorAll('.top-song-item').forEach(item => {
      const track = topSongsList.find(t => t.id === item.dataset.trackId);
      if (!track) return;
      item.addEventListener('click', () => playFromList(topSongsList, topSongsList.indexOf(track)));
      bindArtistLinks(item);
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e, track);
      });
    });

    // Top artists
    content.querySelectorAll('.top-artist-card').forEach(card => {
      card.addEventListener('click', () => openArtistPage(card.dataset.artistId));
    });

    // New music videos
    content.querySelectorAll('.music-video-scroll .video-card').forEach(card => {
      const v = (exploreData?.newMusicVideos || []).find(t => t.id === card.dataset.videoId);
      if (v) {
        bindArtistLinks(card);
        card.addEventListener('click', () => playFromList([v], 0));
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showContextMenu(e, v);
        });
      }
    });

    // Mood cards
    attachMoodListeners(content, exploreData?.moods || []);

    // Scroll arrows
    content.querySelectorAll('.scroll-container').forEach(container => {
      const scrollEl = container.querySelector('.album-scroll');
      if (!scrollEl) return;
      container.querySelectorAll('.scroll-arrow').forEach(btn => {
        btn.addEventListener('click', () => {
          const dir = btn.dataset.dir === 'left' ? -1 : 1;
          scrollEl.scrollBy({ left: dir * 400, behavior: 'smooth' });
        });
      });
    });
  }

  function attachMoodListeners(container, moods) {
    container.querySelectorAll('.mood-card').forEach(card => {
      card.addEventListener('click', async () => {
        const moodsSection = $('#explore-moods-section');
        if (!moodsSection) return;
        const savedHtml = moodsSection.innerHTML;
        moodsSection.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
        const playlists = await window.snowify.browseMood(card.dataset.browseId, card.dataset.params);
        if (!playlists?.length) {
          moodsSection.innerHTML = savedHtml;
          showToast('No playlists found for this mood');
          attachMoodListeners(moodsSection.parentElement, moods);
          return;
        }
        let moodHtml = `<h2>${escapeHtml(card.textContent)}</h2>`;
        moodHtml += `<button class="explore-back-btn" id="explore-mood-back">← Back to Moods & Genres</button>`;
        moodHtml += `<div class="album-scroll">`;
        moodHtml += playlists.map(p => `
          <div class="album-card" data-playlist-id="${escapeHtml(p.playlistId)}">
            <img class="album-card-cover" src="${escapeHtml(p.thumbnail)}" alt="" loading="lazy" />
            <div class="album-card-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
            <div class="album-card-meta">${escapeHtml(p.subtitle || '')}</div>
          </div>
        `).join('');
        moodHtml += `</div>`;
        moodsSection.innerHTML = moodHtml;

        const moodScroll = moodsSection.querySelector('.album-scroll');
        if (moodScroll) addScrollArrows(moodScroll);

        $('#explore-mood-back')?.addEventListener('click', () => {
          moodsSection.innerHTML = savedHtml;
          attachMoodListeners(moodsSection.parentElement, moods);
        });

        moodsSection.querySelectorAll('.album-card').forEach(ac => {
          ac.addEventListener('click', async () => {
            const pid = ac.dataset.playlistId;
            try {
              const vids = await window.snowify.getPlaylistVideos?.(pid);
              if (vids?.length) playFromList(vids, 0);
              else showToast('Could not load playlist');
            } catch {
              showToast('Could not load playlist');
            }
          });
        });
      });
    });
  }

  function attachExploreAlbumListeners(container, albums) {
    container.querySelectorAll('.album-card').forEach(card => {
      const albumId = card.dataset.albumId;
      if (!albumId) return;
      const meta = albums.find(a => a.albumId === albumId);
      card.querySelector('.album-card-play')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const album = await window.snowify.albumTracks(albumId);
        if (album?.tracks?.length) playFromList(album.tracks, 0);
      });
      bindArtistLinks(card);
      card.addEventListener('click', () => showAlbumDetail(albumId, meta));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showAlbumContextMenu(e, albumId, meta);
      });
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        if (e.ctrlKey) playNext();
        else if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
        break;
      case 'ArrowLeft':
        if (e.ctrlKey) playPrev();
        else if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 5);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setVolume(state.volume + 0.05);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setVolume(state.volume - 0.05);
        break;
      case '/':
        e.preventDefault();
        switchView('search');
        break;
    }
  });

  function showInputModal(title, defaultValue = '') {
    return new Promise((resolve) => {
      const overlay = $('#input-modal');
      const input = $('#input-modal-input');
      const titleEl = $('#input-modal-title');

      titleEl.textContent = title;
      input.value = defaultValue;
      overlay.classList.remove('hidden');
      setTimeout(() => { input.focus(); input.select(); }, 50);

      function cleanup(result) {
        overlay.classList.add('hidden');
        input.removeEventListener('keydown', onKey);
        $('#input-modal-ok').removeEventListener('click', onOk);
        $('#input-modal-cancel').removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlay);
        resolve(result);
      }

      function onOk() {
        const val = input.value.trim();
        cleanup(val || null);
      }
      function onCancel() { cleanup(null); }
      function onKey(e) {
        if (e.key === 'Enter') onOk();
        if (e.key === 'Escape') onCancel();
      }
      function onOverlay(e) {
        if (e.target === overlay) onCancel();
      }

      input.addEventListener('keydown', onKey);
      $('#input-modal-ok').addEventListener('click', onOk);
      $('#input-modal-cancel').addEventListener('click', onCancel);
      overlay.addEventListener('click', onOverlay);
    });
  }

  let toastTimeout = null;
  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toastTimeout);
    requestAnimationFrame(() => toast.classList.add('show'));
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 300);
    }, 2500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Wrap an .album-scroll or .similar-artists-scroll element with scroll arrows if not already wrapped. */
  function addScrollArrows(scrollEl) {
    if (!scrollEl || scrollEl.parentElement?.classList.contains('scroll-container')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'scroll-container';
    scrollEl.parentNode.insertBefore(wrapper, scrollEl);
    const leftBtn = document.createElement('button');
    leftBtn.className = 'scroll-arrow scroll-arrow-left';
    leftBtn.dataset.dir = 'left';
    leftBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
    const rightBtn = document.createElement('button');
    rightBtn.className = 'scroll-arrow scroll-arrow-right';
    rightBtn.dataset.dir = 'right';
    rightBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    wrapper.appendChild(leftBtn);
    wrapper.appendChild(scrollEl);
    wrapper.appendChild(rightBtn);
    leftBtn.addEventListener('click', () => scrollEl.scrollBy({ left: -400, behavior: 'smooth' }));
    rightBtn.addEventListener('click', () => scrollEl.scrollBy({ left: 400, behavior: 'smooth' }));
  }

  function renderArtistLinks(track) {
    if (track.artists?.length) {
      return track.artists.map((a, i, arr) => {
        const sep = i < arr.length - 1 ? ', ' : '';
        return (a.id
          ? `<span class="artist-link" data-artist-id="${escapeHtml(a.id)}">${escapeHtml(a.name)}</span>`
          : escapeHtml(a.name)) + sep;
      }).join('');
    }
    if (track.artistId) {
      return `<span class="artist-link" data-artist-id="${escapeHtml(track.artistId)}">${escapeHtml(track.artist)}</span>`;
    }
    return escapeHtml(track.artist || 'Unknown Artist');
  }

  function bindArtistLinks(container) {
    container.querySelectorAll('.artist-link[data-artist-id]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        openArtistPage(link.dataset.artistId);
      });
    });
  }

  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  document.querySelector('[data-playlist="liked"]')?.addEventListener('click', () => {
    showPlaylistDetail({ id: 'liked', name: 'Liked Songs', tracks: state.likedSongs }, true);
  });

  async function showAlbumDetail(albumId, albumMeta) {
    switchView('album');

    const heroName = $('#album-hero-name');
    const heroMeta = $('#album-hero-meta');
    const heroCover = $('#album-hero-img');
    const heroType = $('#album-hero-type');
    const tracksContainer = $('#album-tracks');

    heroName.textContent = albumMeta?.name || 'Loading...';
    heroMeta.textContent = '';
    heroType.textContent = (albumMeta?.type || 'ALBUM').toUpperCase();
    heroCover.src = albumMeta?.thumbnail || '';
    tracksContainer.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;

    const album = await window.snowify.albumTracks(albumId);
    if (!album || !album.tracks.length) {
      tracksContainer.innerHTML = `<div class="empty-state"><p>Could not load album tracks.</p></div>`;
      return;
    }

    heroName.textContent = album.name || albumMeta?.name || 'Album';
    const parts = [];
    if (album.artist) parts.push(renderArtistLinks(album));
    if (albumMeta?.year) parts.push(escapeHtml(String(albumMeta.year)));
    parts.push(`${album.tracks.length} song${album.tracks.length !== 1 ? 's' : ''}`);
    heroMeta.innerHTML = parts.join(' \u00B7 ');
    bindArtistLinks(heroMeta);
    if (album.thumbnail) heroCover.src = album.thumbnail;

    renderTrackList(tracksContainer, album.tracks, 'album');

    $('#btn-album-play-all').onclick = () => {
      if (album.tracks.length) playFromList(album.tracks, 0);
    };
    $('#btn-album-shuffle').onclick = () => {
      if (album.tracks.length) {
        const shuffled = [...album.tracks].sort(() => Math.random() - 0.5);
        playFromList(shuffled, 0);
      }
    };
  }

  async function openArtistPage(artistId) {
    if (!artistId) return;
    switchView('artist');

    const avatar = $('#artist-avatar');
    const bannerEl = $('#artist-banner');
    const bannerImg = $('#artist-banner-img');
    const nameEl = $('#artist-name');
    const followersEl = $('#artist-followers');
    const descEl = $('#artist-description');
    const tagsEl = $('#artist-tags');
    const aboutSection = $('#artist-about-section');
    const popularContainer = $('#artist-popular-tracks');
    const discographyContainer = $('#artist-discography');
    const videosSection = $('#artist-videos-section');
    const videosContainer = $('#artist-videos');
    const liveSection = $('#artist-live-section');
    const liveContainer = $('#artist-live');
    const fansSection = $('#artist-fans-section');
    const fansContainer = $('#artist-fans');

    avatar.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    avatar.classList.remove('loaded');
    avatar.classList.add('shimmer');
    bannerEl.style.display = 'none';
    bannerImg.src = '';
    nameEl.textContent = 'Loading...';
    followersEl.textContent = '';
    descEl.textContent = '';
    tagsEl.innerHTML = '';
    aboutSection.style.display = 'none';
    videosSection.style.display = 'none';
    liveSection.style.display = 'none';
    fansSection.style.display = 'none';
    popularContainer.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
    discographyContainer.innerHTML = '';
    videosContainer.innerHTML = '';
    liveContainer.innerHTML = '';
    fansContainer.innerHTML = '';

    const info = await window.snowify.artistInfo(artistId);

    if (!info) {
      nameEl.textContent = 'Artist not found';
      popularContainer.innerHTML = `<div class="empty-state"><p>Could not load artist info.</p></div>`;
      return;
    }

    nameEl.textContent = info.name;
    followersEl.textContent = info.monthlyListeners || '';

    if (info.avatar) {
      avatar.addEventListener('load', () => {
        avatar.classList.remove('shimmer');
        avatar.classList.add('loaded');
      }, { once: true });
      avatar.src = info.avatar;
    }

    if (info.banner) {
      bannerImg.src = info.banner;
      bannerEl.style.display = '';
    } else {
      bannerEl.style.display = 'none';
    }

    aboutSection.style.display = 'none';

    // Follow button
    const followBtn = $('#btn-artist-follow');
    const isFollowed = () => state.followedArtists.some(a => a.artistId === artistId);
    const updateFollowBtn = () => {
      followBtn.textContent = isFollowed() ? 'Following' : 'Follow';
      followBtn.classList.toggle('following', isFollowed());
    };
    updateFollowBtn();
    followBtn.onclick = () => {
      if (isFollowed()) {
        state.followedArtists = state.followedArtists.filter(a => a.artistId !== artistId);
        showToast(`Unfollowed ${info.name}`);
      } else {
        state.followedArtists.push({ artistId, name: info.name, avatar: info.avatar || '' });
        showToast(`Following ${info.name}`);
      }
      _cachedReleases = null;
      _lastReleaseFetch = 0;
      saveState();
      updateFollowBtn();
    };

    // Share button
    const shareBtn = $('#btn-artist-share');
    shareBtn.onclick = () => {
      navigator.clipboard.writeText(`https://music.youtube.com/channel/${artistId}`);
      showToast('Link copied to clipboard');
    };

    // Use topSongs for popular section
    const popular = (info.topSongs || []).slice(0, 5);

    if (!popular.length) {
      popularContainer.innerHTML = `<div class="empty-state"><p>No tracks found for this artist.</p></div>`;
      discographyContainer.innerHTML = '';
      return;
    }

    renderTrackList(popularContainer, popular, 'artist-popular');

    // Discography: horizontal scrollable album cards with filter
    const allReleases = [
      ...(info.topAlbums || []),
      ...(info.topSingles || [])
    ].sort((a, b) => (b.year || 0) - (a.year || 0));

    function renderDiscography(filter) {
      const items = filter === 'all' ? allReleases : allReleases.filter(a => a.type === filter);
      if (!items.length) {
        discographyContainer.innerHTML = `<div class="empty-state"><p>No releases found.</p></div>`;
        return;
      }
      discographyContainer.innerHTML = items.map(a => `
        <div class="album-card" data-album-id="${a.albumId}">
          <img class="album-card-cover" src="${escapeHtml(a.thumbnail)}" alt="" loading="lazy" />
          <button class="album-card-play" title="Play">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
          </button>
          <div class="album-card-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
          <div class="album-card-meta">${[a.year, a.type].filter(Boolean).join(' \u00B7 ')}</div>
        </div>
      `).join('');

      addScrollArrows(discographyContainer);
      discographyContainer.querySelectorAll('.album-card').forEach(card => {
        const albumId = card.dataset.albumId;
        const meta = items.find(a => a.albumId === albumId);
        card.querySelector('.album-card-play').addEventListener('click', async (e) => {
          e.stopPropagation();
          const album = await window.snowify.albumTracks(albumId);
          if (album && album.tracks.length) playFromList(album.tracks, 0);
        });
        card.addEventListener('click', () => {
          showAlbumDetail(albumId, meta);
        });
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showAlbumContextMenu(e, albumId, meta);
        });
      });
    }

    // Wire up filter buttons (use onclick to avoid listener accumulation)
    const filterBtns = document.querySelectorAll('#disco-filters .disco-filter');
    filterBtns.forEach(btn => {
      btn.onclick = () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderDiscography(btn.dataset.filter);
      };
    });

    // Reset filter to "all" and render
    filterBtns.forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
    renderDiscography('all');

    // Music Videos slider
    const topVideos = info.topVideos || [];
    if (topVideos.length) {
      videosSection.style.display = '';
      videosContainer.innerHTML = topVideos.map(v => `
        <div class="video-card" data-video-id="${escapeHtml(v.videoId)}">
          <img class="video-card-thumb" src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy" />
          <button class="video-card-play" title="Watch">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
          </button>
          <div class="video-card-name" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</div>
          ${v.duration ? `<div class="video-card-duration">${v.duration}</div>` : ''}
        </div>
      `).join('');

      addScrollArrows(videosContainer);
      videosContainer.querySelectorAll('.video-card').forEach(card => {
        const vid = card.dataset.videoId;
        const video = topVideos.find(v => v.videoId === vid);
        card.addEventListener('click', () => {
          if (video) openVideoPlayer(video.videoId, video.name, video.artist);
        });
      });
    }

    // Live Performances section (only if available)
    const livePerfs = info.livePerformances || [];
    if (livePerfs.length) {
      liveSection.style.display = '';
      liveContainer.innerHTML = livePerfs.map(v => `
        <div class="video-card" data-video-id="${escapeHtml(v.videoId)}">
          <img class="video-card-thumb" src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy" />
          <button class="video-card-play" title="Watch">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
          </button>
          <div class="video-card-name" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</div>
        </div>
      `).join('');

      addScrollArrows(liveContainer);
      liveContainer.querySelectorAll('.video-card').forEach(card => {
        const vid = card.dataset.videoId;
        const video = livePerfs.find(v => v.videoId === vid);
        card.addEventListener('click', () => {
          if (video) openVideoPlayer(video.videoId, video.name, video.artist);
        });
      });
    }

    // Fans might also like section
    const fansAlsoLike = info.fansAlsoLike || [];
    if (fansAlsoLike.length) {
      fansSection.style.display = '';
      fansContainer.innerHTML = fansAlsoLike.map(a => `
        <div class="similar-artist-card" data-artist-id="${escapeHtml(a.artistId)}">
          <img class="similar-artist-avatar" src="${escapeHtml(a.thumbnail || '')}" alt="" loading="lazy" />
          <div class="similar-artist-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
        </div>
      `).join('');

      addScrollArrows(fansContainer);
      fansContainer.querySelectorAll('.similar-artist-card').forEach(card => {
        card.addEventListener('click', () => {
          const id = card.dataset.artistId;
          if (id) openArtistPage(id);
        });
      });
    }

    // Play all: use popular tracks
    $('#btn-artist-play-all').onclick = () => {
      if (popular.length) playFromList(popular, 0);
    };
  }

  function formatFollowers(n) {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toString();
  }

  // ─── Drag & Drop helpers ───

  let _dragActive = false;
  let _draggedTrack = null;

  function startTrackDrag(e, track) {
    _draggedTrack = track;
    _dragActive = true;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', track.title);
    const el = e.target.closest('.track-row, .track-card');
    if (el) el.classList.add('dragging');
    document.querySelectorAll('.playlist-item').forEach(p => p.classList.add('drop-target'));
  }

  document.addEventListener('dragend', () => {
    _dragActive = false;
    _draggedTrack = null;
    document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  });

  function handleTrackDrop(e, playlistId) {
    const track = _draggedTrack;
    if (!track || !track.id) return;

    if (playlistId === 'liked') {
      if (state.likedSongs.some(t => t.id === track.id)) {
        showToast('Already in Liked Songs');
        return;
      }
      state.likedSongs.push(track);
      saveState();
      updateLikedCount();
      showToast('Added to Liked Songs');
    } else {
      const pl = state.playlists.find(p => p.id === playlistId);
      if (!pl) return;
      if (pl.tracks.some(t => t.id === track.id)) {
        showToast(`Already in "${pl.name}"`);
        return;
      }
      pl.tracks.push(track);
      saveState();
      renderPlaylists();
      showToast(`Added to "${pl.name}"`);
    }
  }

  // ─── Lyrics Panel ───

  const lyricsPanel = $('#lyrics-panel');
  const lyricsBody = $('#lyrics-body');
  const btnLyrics = $('#btn-lyrics');
  let _lyricsLines = [];
  let _lyricsTrackId = null;
  let _lyricsSyncInterval = null;
  let _lyricsVisible = false;

  btnLyrics.addEventListener('click', () => {
    _lyricsVisible = !_lyricsVisible;
    lyricsPanel.classList.toggle('hidden', !_lyricsVisible);
    lyricsPanel.classList.toggle('visible', _lyricsVisible);
    btnLyrics.classList.toggle('active', _lyricsVisible);

    // Close queue if lyrics opens
    if (_lyricsVisible) {
      queuePanel.classList.add('hidden');
      queuePanel.classList.remove('visible');
    }

    const current = state.queue[state.queueIndex];
    if (_lyricsVisible && current && _lyricsTrackId !== current.id) {
      fetchAndShowLyrics(current);
    }
    if (_lyricsVisible) startLyricsSync();
    else stopLyricsSync();
  });

  $('#btn-close-lyrics').addEventListener('click', () => {
    _lyricsVisible = false;
    lyricsPanel.classList.add('hidden');
    lyricsPanel.classList.remove('visible');
    btnLyrics.classList.remove('active');
    stopLyricsSync();
  });

  // Close lyrics when queue opens
  $('#btn-queue').addEventListener('click', () => {
    if (_lyricsVisible) {
      _lyricsVisible = false;
      lyricsPanel.classList.add('hidden');
      lyricsPanel.classList.remove('visible');
      btnLyrics.classList.remove('active');
      stopLyricsSync();
    }
  });

  async function fetchAndShowLyrics(track) {
    if (!track) return;
    _lyricsTrackId = track.id;
    _lyricsLines = [];
    _lastActiveLyricIdx = -1;

    lyricsBody.innerHTML = '<div class="lyrics-loading"><div class="spinner"></div><p>Searching for lyrics\u2026</p></div>';

    // Parse duration: try audio.duration first, then the track string "m:ss"
    let durationSec = null;
    if (audio.duration && !isNaN(audio.duration) && audio.duration > 0) {
      durationSec = Math.round(audio.duration);
    } else if (track.duration) {
      const parts = track.duration.split(':');
      if (parts.length === 2) durationSec = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }

    try {
      const result = await window.snowify.getLyrics(track.title, track.artist, track.album || '', durationSec);

      // Ensure we're still viewing the same track
      if (_lyricsTrackId !== track.id) return;

      if (!result) {
        showLyricsEmpty();
        return;
      }

      if (result.synced) {
        _lyricsLines = parseLRC(result.synced);
        renderSyncedLyrics();
        startLyricsSync();
      } else if (result.plain) {
        renderPlainLyrics(result.plain);
        showToast('Synced lyrics not available for this song');
      } else {
        showLyricsEmpty();
      }

    } catch (err) {
      console.error('Lyrics error:', err);
      if (_lyricsTrackId === track.id) {
        lyricsBody.innerHTML = '<div class="lyrics-empty"><p>Failed to load lyrics</p></div>';
      }
    }
  }

  function showLyricsEmpty() {
    lyricsBody.innerHTML = `<div class="lyrics-empty">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-subdued)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      <p>No lyrics found for this song</p>
    </div>`;
  }

  function parseLRC(lrcText) {
    const lines = [];
    const regex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)/;
    lrcText.split('\n').forEach(line => {
      const match = line.match(regex);
      if (match) {
        const min = parseInt(match[1]);
        const sec = parseInt(match[2]);
        let ms = parseInt(match[3]);
        if (match[3].length === 2) ms *= 10;
        const time = min * 60 + sec + ms / 1000;
        const text = match[4].trim();
        if (text) lines.push({ time, text });
      }
    });
    return lines.sort((a, b) => a.time - b.time);
  }

  function renderSyncedLyrics() {
    lyricsBody.innerHTML = `<div class="lyrics-content synced">
      <div class="lyrics-spacer"></div>
      ${_lyricsLines.map((line, i) =>
        `<div class="lyrics-line" data-index="${i}" data-time="${line.time}">${escapeHtml(line.text)}</div>`
      ).join('')}
      <div class="lyrics-spacer"></div>
    </div>`;

    // Click a line to seek
    lyricsBody.querySelectorAll('.lyrics-line').forEach(el => {
      el.addEventListener('click', () => {
        const time = parseFloat(el.dataset.time);
        if (audio.duration && !isNaN(time)) {
          audio.currentTime = time;
          if (audio.paused) {
            audio.play();
            state.isPlaying = true;
            updatePlayButton();
          }
        }
      });
    });
  }

  function renderPlainLyrics(text) {
    const lines = text.split('\n').filter(l => l.trim());
    lyricsBody.innerHTML = `<div class="lyrics-content plain">
      <div class="lyrics-spacer"></div>
      ${lines.map(l => `<div class="lyrics-line plain-line">${escapeHtml(l)}</div>`).join('')}
      <div class="lyrics-spacer"></div>
    </div>`;
  }

  function startLyricsSync() {
    stopLyricsSync();
    if (!_lyricsLines.length) return;
    _lyricsSyncInterval = setInterval(() => {
      if (audio.paused) return;
      syncLyrics();
    }, 100);
  }

  function stopLyricsSync() {
    if (_lyricsSyncInterval) {
      clearInterval(_lyricsSyncInterval);
      _lyricsSyncInterval = null;
    }
  }

  let _lastActiveLyricIdx = -1;
  function syncLyrics() {
    if (!_lyricsLines.length || !_lyricsVisible) return;
    const ct = audio.currentTime;

    // Find current line index
    let activeIdx = -1;
    for (let i = _lyricsLines.length - 1; i >= 0; i--) {
      if (ct >= _lyricsLines[i].time) {
        activeIdx = i;
        break;
      }
    }

    if (activeIdx === _lastActiveLyricIdx) return;
    _lastActiveLyricIdx = activeIdx;

    const allLines = lyricsBody.querySelectorAll('.lyrics-line');
    allLines.forEach((el, i) => {
      el.classList.toggle('active', i === activeIdx);
      const dist = Math.abs(i - activeIdx);
      if (activeIdx < 0) {
        el.style.opacity = '0.35';
      } else if (dist === 0) {
        el.style.opacity = '1';
      } else if (dist <= 2) {
        el.style.opacity = '0.45';
      } else {
        el.style.opacity = '0.2';
      }
    });

    // Auto-scroll active line to center
    if (activeIdx >= 0) {
      const activeLine = allLines[activeIdx];
      if (activeLine) {
        activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  // Trigger lyrics fetch on track change
  function onTrackChanged(track) {
    _lastActiveLyricIdx = -1;
    if (_lyricsVisible) {
      fetchAndShowLyrics(track);
    } else {
      _lyricsTrackId = null;
    }
  }

  // ─── Video Player ───

  const videoOverlay = $('#video-overlay');
  const videoPlayer = $('#video-player');
  const videoLoading = $('#video-loading');
  const videoTitle = $('#video-overlay-title');
  const videoArtist = $('#video-overlay-artist');
  let _wasPlayingBeforeVideo = false;
  let _videoAudio = null; // separate audio track for split streams

  $('#btn-close-video').addEventListener('click', closeVideoPlayer);

  videoOverlay.addEventListener('click', (e) => {
    if (e.target === videoOverlay) closeVideoPlayer();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !videoOverlay.classList.contains('hidden')) {
      closeVideoPlayer();
    }
  });

  async function openVideoPlayer(videoId, name, artist) {
    videoTitle.textContent = name || 'Music Video';
    videoArtist.textContent = artist || '';
    videoPlayer.src = '';
    videoPlayer.poster = '';
    if (_videoAudio) { _videoAudio.pause(); _videoAudio = null; }
    videoLoading.classList.remove('hidden');
    videoOverlay.classList.remove('hidden');

    // Pause audio playback while watching video
    _wasPlayingBeforeVideo = state.isPlaying;
    if (state.isPlaying) {
      audio.pause();
      state.isPlaying = false;
      updatePlayButton();
    }

    try {
      const result = await window.snowify.getVideoStreamUrl(videoId, state.videoQuality, state.videoPremuxed);
      videoPlayer.src = result.videoUrl;
      videoLoading.classList.add('hidden');

      if (result.audioUrl) {
        // Split streams: sync a separate audio element
        _videoAudio = new Audio(result.audioUrl);
        _videoAudio.volume = state.volume * 0.3;

        videoPlayer.muted = true;

        // Wait for video to actually start playing before starting audio
        const onVideoPlaying = () => {
          videoPlayer.removeEventListener('playing', onVideoPlaying);
          if (_videoAudio) {
            _videoAudio.currentTime = videoPlayer.currentTime;
            _videoAudio.play();
          }
        };
        videoPlayer.addEventListener('playing', onVideoPlaying);
        videoPlayer.play();

        // Keep audio in sync with video
        videoPlayer.addEventListener('seeked', syncVideoAudio);
        videoPlayer.addEventListener('pause', onVideoPause);
        videoPlayer.addEventListener('play', onVideoPlay);

        // Periodic drift correction
        videoPlayer.addEventListener('timeupdate', syncVideoAudio);
      } else {
        // Muxed stream: play directly
        videoPlayer.muted = false;
        videoPlayer.play();
      }
    } catch (err) {
      console.error('Video playback error:', err);
      videoLoading.classList.add('hidden');
      showToast('Failed to load video');
      closeVideoPlayer();
    }
  }

  function syncVideoAudio() {
    if (_videoAudio && Math.abs(videoPlayer.currentTime - _videoAudio.currentTime) > 0.3) {
      _videoAudio.currentTime = videoPlayer.currentTime;
    }
  }

  function onVideoPause() { _videoAudio?.pause(); }
  function onVideoPlay() {
    if (_videoAudio) {
      _videoAudio.currentTime = videoPlayer.currentTime;
      _videoAudio.play();
    }
  }

  function closeVideoPlayer() {
    videoOverlay.classList.add('hidden');
    videoPlayer.pause();
    videoPlayer.removeEventListener('seeked', syncVideoAudio);
    videoPlayer.removeEventListener('timeupdate', syncVideoAudio);
    videoPlayer.removeEventListener('pause', onVideoPause);
    videoPlayer.removeEventListener('play', onVideoPlay);
    videoPlayer.src = '';
    if (_videoAudio) { _videoAudio.pause(); _videoAudio.src = ''; _videoAudio = null; }

    // Resume audio if it was playing before
    if (_wasPlayingBeforeVideo && state.queue[state.queueIndex]) {
      audio.play().then(() => {
        state.isPlaying = true;
        updatePlayButton();
      }).catch(() => {});
    }
  }

  function init() {
    loadState();

    // Show welcome screen on first launch (no account, never skipped)
    const hasSkipped = localStorage.getItem('snowify_welcome_skipped');
    if (!hasSkipped) {
      // Wait briefly for auto-sign-in from saved credentials to complete
      // then check if a user is available
      let resolved = false;
      const tryResolve = (user) => {
        if (resolved) return;
        resolved = true;
        if (user) {
          localStorage.setItem('snowify_welcome_skipped', '1');
          finishInit();
        } else {
          showWelcomeScreen();
        }
      };
      // Listen for auth state in case auto-sign-in fires
      window.snowify.onAuthStateChanged((user) => { if (user) tryResolve(user); });
      // Also check after a short delay in case there's no saved session
      setTimeout(async () => {
        const user = await window.snowify.getUser();
        tryResolve(user);
      }, 800);
    } else {
      finishInit();
    }
  }

  function finishInit() {
    updateGreeting();
    setVolume(state.volume);
    if (state.discordRpc) window.snowify.connectDiscord();
    btnShuffle.classList.toggle('active', state.shuffle);
    btnRepeat.classList.toggle('active', state.repeat !== 'off');
    updateRepeatButton();
    renderPlaylists();
    renderHome();
    initSettings();
    document.querySelector('#app').classList.add('no-player');
  }

  function showWelcomeScreen() {
    const overlay = $('#welcome-overlay');
    overlay.classList.remove('hidden');

    const emailInput = $('#welcome-email');
    const passInput = $('#welcome-password');
    const errorEl = $('#welcome-auth-error');

    const clearError = () => errorEl.classList.add('hidden');
    const showError = (msg) => { errorEl.textContent = msg; errorEl.classList.remove('hidden'); };

    $('#btn-welcome-sign-in').addEventListener('click', async () => {
      clearError();
      const email = emailInput.value.trim();
      const password = passInput.value;
      if (!email || !password) { showError('Please enter email and password'); return; }
      const result = await window.snowify.signInWithEmail(email, password);
      if (result?.error) { showError(result.error); return; }
      localStorage.setItem('snowify_welcome_skipped', '1');
      dismissWelcome();
      showToast('Signed in successfully');
    });

    $('#btn-welcome-sign-up').addEventListener('click', async () => {
      clearError();
      const email = emailInput.value.trim();
      const password = passInput.value;
      if (!email || !password) { showError('Please enter email and password'); return; }
      if (password.length < 6) { showError('Password must be at least 6 characters'); return; }
      const result = await window.snowify.signUpWithEmail(email, password);
      if (result?.error) { showError(result.error); return; }
      localStorage.setItem('snowify_welcome_skipped', '1');
      dismissWelcome();
      showToast('Account created & signed in');
    });

    $('#btn-welcome-skip').addEventListener('click', () => {
      localStorage.setItem('snowify_welcome_skipped', '1');
      dismissWelcome();
    });
  }

  function dismissWelcome() {
    const overlay = $('#welcome-overlay');
    overlay.classList.add('fade-out');
    overlay.addEventListener('animationend', () => {
      overlay.classList.add('hidden');
      overlay.classList.remove('fade-out');
    }, { once: true });
    finishInit();
  }

  // ─── Cloud Sync ───

  let _cloudSaveTimeout = null;
  let _cloudUser = null;
  let _cloudSyncPaused = false;

  function cloudSaveDebounced() {
    if (!_cloudUser || _cloudSyncPaused) return;
    clearTimeout(_cloudSaveTimeout);
    _cloudSaveTimeout = setTimeout(async () => {
      const data = {
        playlists: state.playlists,
        likedSongs: state.likedSongs,
        recentTracks: state.recentTracks,
        followedArtists: state.followedArtists,
        volume: state.volume,
        shuffle: state.shuffle,
        repeat: state.repeat,
        musicOnly: state.musicOnly,
        autoplay: state.autoplay,
        audioQuality: state.audioQuality,
        videoQuality: state.videoQuality,
        videoPremuxed: state.videoPremuxed,
        animations: state.animations,
        effects: state.effects,
        theme: state.theme,
        discordRpc: state.discordRpc,
        country: state.country
      };
      const result = await window.snowify.cloudSave(data);
      if (result?.error) console.error('Cloud save failed:', result.error);
      else updateSyncStatus('Synced just now');
    }, 3000);
  }

  async function cloudLoadAndMerge({ forceCloud = false } = {}) {
    const cloud = await window.snowify.cloudLoad();
    if (!cloud) return false;
    // forceCloud: always use cloud data (e.g. on sign-in / fresh device)
    // otherwise: last-write-wins by timestamp
    const localTime = parseInt(localStorage.getItem('snowify_lastSave') || '0');
    const shouldApply = forceCloud || (cloud.updatedAt && cloud.updatedAt > localTime);
    if (shouldApply) {
      state.playlists = cloud.playlists || state.playlists;
      state.likedSongs = cloud.likedSongs || state.likedSongs;
      state.recentTracks = cloud.recentTracks || state.recentTracks;
      state.followedArtists = cloud.followedArtists || state.followedArtists;
      state.volume = cloud.volume ?? state.volume;
      state.shuffle = cloud.shuffle ?? state.shuffle;
      state.repeat = cloud.repeat || state.repeat;
      state.musicOnly = cloud.musicOnly ?? state.musicOnly;
      state.autoplay = cloud.autoplay ?? state.autoplay;
      state.audioQuality = cloud.audioQuality || state.audioQuality;
      state.videoQuality = cloud.videoQuality || state.videoQuality;
      state.videoPremuxed = cloud.videoPremuxed ?? state.videoPremuxed;
      state.animations = cloud.animations ?? state.animations;
      state.effects = cloud.effects ?? state.effects;
      state.theme = cloud.theme || state.theme;
      state.discordRpc = cloud.discordRpc ?? state.discordRpc;
      state.country = cloud.country || state.country;
      // Pause cloud save so saveState() doesn't push old data back up
      _cloudSyncPaused = true;
      saveState();
      _cloudSyncPaused = false;
      renderPlaylists();
      renderHome();
      // Apply synced theme
      if (state.theme === 'dark') {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', state.theme);
      }
      // Re-apply synced settings to UI controls
      const aq = $('#setting-quality'); if (aq) aq.value = state.audioQuality;
      const vq = $('#setting-video-quality'); if (vq) vq.value = state.videoQuality;
      const at = $('#setting-autoplay'); if (at) at.checked = state.autoplay;
      const vp = $('#setting-video-premuxed'); if (vp) vp.checked = state.videoPremuxed;
      const an = $('#setting-animations'); if (an) an.checked = state.animations;
      const ef = $('#setting-effects'); if (ef) ef.checked = state.effects;
      const dr = $('#setting-discord-rpc'); if (dr) dr.checked = state.discordRpc;
      const co = $('#setting-country'); if (co) co.value = state.country || '';
      if (state.country) window.snowify.setCountry(state.country);
      document.documentElement.classList.toggle('no-animations', !state.animations);
      document.documentElement.classList.toggle('no-effects', !state.effects);
      audio.volume = state.volume * 0.3;
      showToast('Synced from cloud');
      return true;
    }
    return false;
  }

  function updateSyncStatus(text) {
    const el = $('#account-sync-status');
    if (el) el.textContent = text;
  }

  function updateAccountUI(user) {
    _cloudUser = user;
    const signedOut = $('#account-signed-out');
    const signedIn = $('#account-signed-in');
    if (user) {
      signedOut.classList.add('hidden');
      signedIn.classList.remove('hidden');
      const avatar = $('#profile-avatar');
      const nameEl = $('#profile-display-name');
      const emailEl = $('#profile-email');
      nameEl.textContent = user.displayName || 'User';
      emailEl.textContent = user.email || '';
      // Default avatar: first letter of name on accent background
      if (user.photoURL) {
        avatar.src = user.photoURL;
      } else {
        avatar.src = generateDefaultAvatar(user.displayName || user.email || 'U');
      }
      updateSyncStatus('Connected');
    } else {
      signedOut.classList.remove('hidden');
      signedIn.classList.add('hidden');
    }
  }

  function generateDefaultAvatar(name) {
    const letter = name.charAt(0).toUpperCase();
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    // Use accent color from CSS
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#aa55e6';
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(64, 64, 64, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 56px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, 64, 67);
    return canvas.toDataURL();
  }

  // Listen for auth state changes from main process
  window.snowify.onAuthStateChanged(async (user) => {
    updateAccountUI(user);
    if (user) {
      // On sign-in, always pull cloud data first — cloud wins if it exists.
      // This prevents empty local state from overwriting cloud data.
      _cloudSyncPaused = true;
      const loaded = await cloudLoadAndMerge({ forceCloud: true });
      _cloudSyncPaused = false;
      // If cloud had nothing, push local state up as the initial backup
      if (!loaded) {
        await forceCloudSave();
      }
    }
  });

  async function forceCloudSave() {
    if (!_cloudUser) return;
    const data = {
      playlists: state.playlists,
      likedSongs: state.likedSongs,
      recentTracks: state.recentTracks,
      followedArtists: state.followedArtists,
      volume: state.volume,
      shuffle: state.shuffle,
      repeat: state.repeat,
      musicOnly: state.musicOnly,
      autoplay: state.autoplay,
      audioQuality: state.audioQuality,
      videoQuality: state.videoQuality,
      videoPremuxed: state.videoPremuxed,
      animations: state.animations,
      effects: state.effects,
      theme: state.theme,
      discordRpc: state.discordRpc,
      country: state.country
    };
    const result = await window.snowify.cloudSave(data);
    if (result?.error) console.error('Cloud save failed:', result.error);
    else updateSyncStatus('Synced just now');
  }

  // ─── Spotify Import (CSV) ───

  function openSpotifyImport() {
    const modal = $('#spotify-modal');
    const stepSelect = $('#spotify-step-url');
    const stepProgress = $('#spotify-step-progress');
    const errorEl = $('#spotify-error');
    const fileListEl = $('#spotify-file-list');
    const startBtn = $('#spotify-start');

    let cancelled = false;
    let pendingPlaylists = null;

    // Reset
    errorEl.classList.add('hidden');
    fileListEl.classList.add('hidden');
    fileListEl.innerHTML = '';
    stepSelect.classList.remove('hidden');
    stepProgress.classList.add('hidden');
    startBtn.disabled = true;
    modal.classList.remove('hidden');

    function cleanup() {
      cancelled = true;
      modal.classList.add('hidden');
      resetModal();
    }

    function resetModal() {
      startBtn.disabled = true;
      startBtn.textContent = 'Import';
      $('#spotify-modal-title').textContent = 'Import Spotify Playlists';
      $('#spotify-done-buttons').style.display = 'none';
      pendingPlaylists = null;
    }

    $('#spotify-cancel').onclick = cleanup;
    modal.onclick = (e) => { if (e.target === modal) cleanup(); };

    // Open PlaylistExport in system browser
    $('#spotify-exportify-link').onclick = (e) => {
      e.preventDefault();
      window.snowify.openExternal('https://playlistexport.com');
    };

    // Pick CSV files via system dialog
    $('#spotify-pick-files').onclick = async () => {
      const playlists = await window.snowify.spotifyPickCsv();
      if (!playlists || !playlists.length) return;

      pendingPlaylists = playlists;
      fileListEl.innerHTML = playlists.map(p =>
        `<div class="spotify-file-item"><span class="spotify-file-name">${escapeHtml(p.name)}</span><span class="spotify-file-count">${p.tracks.length} tracks</span></div>`
      ).join('');
      fileListEl.classList.remove('hidden');
      startBtn.disabled = false;
      errorEl.classList.add('hidden');
    };

    startBtn.onclick = async () => {
      if (!pendingPlaylists || !pendingPlaylists.length) {
        errorEl.textContent = 'Please select at least one CSV file';
        errorEl.classList.remove('hidden');
        return;
      }

      errorEl.classList.add('hidden');
      startBtn.disabled = true;
      startBtn.textContent = 'Importing...';

      // Switch to progress view
      stepSelect.classList.add('hidden');
      stepProgress.classList.remove('hidden');

      const trackList = $('#spotify-track-list');
      const progressFill = $('#spotify-progress-fill');
      const progressText = $('#spotify-progress-text');
      const progressCount = $('#spotify-progress-count');

      let totalImported = 0;
      let totalPlaylists = 0;
      const allFailedTracks = [];

      for (let pi = 0; pi < pendingPlaylists.length; pi++) {
        if (cancelled) break;

        const pl = pendingPlaylists[pi];

        if (pendingPlaylists.length > 1) {
          $('#spotify-modal-title').textContent = `Importing ${pi + 1} of ${pendingPlaylists.length}: ${pl.name}`;
        } else {
          $('#spotify-modal-title').textContent = pl.name;
        }

        progressFill.style.width = '0%';
        progressCount.textContent = '';
        progressText.textContent = 'Matching tracks...';
        trackList.innerHTML = '';

        const total = pl.tracks.length;
        const BATCH_SIZE = 3;

        // Populate track list
        trackList.innerHTML = pl.tracks.map((t, i) => `
          <div class="spotify-track-item pending" id="sp-track-${i}">
            <span class="spotify-track-status"><span class="dots">•••</span></span>
            <span class="spotify-track-title">${escapeHtml(t.title)}</span>
            <span class="spotify-track-artist">${escapeHtml(t.artist)}</span>
          </div>
        `).join('');

        // Match tracks in concurrent batches for speed
        const matchedTracks = [];
        const failedTracks = [];
        let matched = 0;
        let failed = 0;

        for (let i = 0; i < total; i += BATCH_SIZE) {
          if (cancelled) break;

          const batch = pl.tracks.slice(i, Math.min(i + BATCH_SIZE, total));
          const promises = batch.map((t, bi) => {
            const idx = i + bi;
            return window.snowify.spotifyMatchTrack(t.title, t.artist)
              .catch(() => null)
              .then(result => ({ idx, result }));
          });

          const results = await Promise.all(promises);
          if (cancelled) break;

          for (const { idx, result } of results) {
            const t = pl.tracks[idx];
            const el = $(`#sp-track-${idx}`);

            if (result) {
              matchedTracks.push(result);
              matched++;
              if (el) {
                el.classList.remove('pending');
                el.classList.add('matched');
                el.querySelector('.spotify-track-status').innerHTML = '<svg class="check" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 12.5l-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4-7 7z"/></svg>';
              }
            } else {
              failedTracks.push({ title: t.title, artist: t.artist });
              failed++;
              if (el) {
                el.classList.remove('pending');
                el.classList.add('unmatched');
                el.querySelector('.spotify-track-status').innerHTML = '<svg class="cross" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
              }
            }
          }

          // Update progress after each batch
          const done = Math.min(i + BATCH_SIZE, total);
          progressCount.textContent = `${done} / ${total}`;
          progressFill.style.width = `${(done / total) * 100}%`;
          progressText.textContent = pendingPlaylists.length > 1
            ? `Playlist ${pi + 1}/${pendingPlaylists.length} — Matching tracks...`
            : 'Matching tracks...';

          const lastEl = $(`#sp-track-${Math.min(i + BATCH_SIZE, total) - 1}`);
          lastEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }

        if (cancelled) {
          if (matchedTracks.length) {
            const playlist = createPlaylist(pl.name);
            playlist.tracks = matchedTracks;
            saveState();
            renderPlaylists();
            renderLibrary();
          }
          break;
        }

        // Create the playlist
        if (matchedTracks.length) {
          const playlist = createPlaylist(pl.name);
          playlist.tracks = matchedTracks;
          saveState();
          renderPlaylists();
          renderLibrary();
          totalImported += matched;
          totalPlaylists++;
        }

        allFailedTracks.push(...failedTracks);
        progressText.textContent = `Matched ${matched} of ${total}` + (failed ? ` (${failed} not found)` : '');
      }

      if (cancelled) {
        showToast('Import cancelled');
        return;
      }

      // Final summary
      if (pendingPlaylists.length > 1) {
        $('#spotify-modal-title').textContent = 'Import Complete';
        progressText.textContent = `Imported ${totalPlaylists} playlist${totalPlaylists !== 1 ? 's' : ''} — ${totalImported} tracks total`;
        progressFill.style.width = '100%';
        progressCount.textContent = '';
        showToast(`Imported ${totalPlaylists} playlist${totalPlaylists !== 1 ? 's' : ''} — ${totalImported} tracks`);
      } else if (totalPlaylists) {
        showToast(`Imported ${totalImported} tracks`);
      } else {
        showToast('No tracks could be matched');
      }

      // Show failed tracks summary
      if (allFailedTracks.length) {
        trackList.innerHTML = `<div class="spotify-failed-header">Failed to match (${allFailedTracks.length})</div>` +
          allFailedTracks.map(t =>
            `<div class="spotify-track-item unmatched"><span class="spotify-track-status"><svg class="cross" width="16" height="16" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg></span><span class="spotify-track-title">${escapeHtml(t.title)}</span><span class="spotify-track-artist">${escapeHtml(t.artist)}</span></div>`
          ).join('');
        trackList.scrollTop = 0;
      } else {
        trackList.innerHTML = '';
      }

      // Show done button
      $('#spotify-done-buttons').style.display = '';
      $('#spotify-done').onclick = () => {
        cleanup();
        resetModal();
      };
    };
  }

  let _settingsInitialized = false;
  async function initSettings() {
    if (_settingsInitialized) return;
    _settingsInitialized = true;
    const autoplayToggle = $('#setting-autoplay');
    const qualitySelect = $('#setting-quality');
    const videoQualitySelect = $('#setting-video-quality');
    const videoPremuxedToggle = $('#setting-video-premuxed');
    const animationsToggle = $('#setting-animations');
    const effectsToggle = $('#setting-effects');
    const discordRpcToggle = $('#setting-discord-rpc');
    const countrySelect = $('#setting-country');

    autoplayToggle.checked = state.autoplay;
    discordRpcToggle.checked = state.discordRpc;
    qualitySelect.value = state.audioQuality;
    videoQualitySelect.value = state.videoQuality;
    videoPremuxedToggle.checked = state.videoPremuxed;
    videoQualitySelect.disabled = state.videoPremuxed;
    animationsToggle.checked = state.animations;
    effectsToggle.checked = state.effects;
    countrySelect.value = state.country || '';
    // Apply saved country to backend
    if (state.country) window.snowify.setCountry(state.country);
    document.documentElement.classList.toggle('no-animations', !state.animations);
    document.documentElement.classList.toggle('no-effects', !state.effects);

    // Apply theme
    function applyTheme(theme) {
      if (theme === 'dark') {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', theme);
      }
    }
    applyTheme(state.theme);

    // Theme dropdown
    const themeSelect = $('#theme-select');
    if (themeSelect) {
      themeSelect.value = state.theme;
      themeSelect.addEventListener('change', () => {
        state.theme = themeSelect.value;
        applyTheme(state.theme);
        saveState();
      });
    }

    autoplayToggle.addEventListener('change', () => {
      state.autoplay = autoplayToggle.checked;
      saveState();
    });

    discordRpcToggle.addEventListener('change', async () => {
      state.discordRpc = discordRpcToggle.checked;
      saveState();
      if (state.discordRpc) {
        const ok = await window.snowify.connectDiscord();
        if (!ok) {
          showToast('Could not connect to Discord — is it running?');
          state.discordRpc = false;
          discordRpcToggle.checked = false;
          saveState();
          return;
        }
        const track = state.queue[state.queueIndex];
        if (track && state.isPlaying) updateDiscordPresence(track);
      } else {
        clearDiscordPresence();
        window.snowify.disconnectDiscord();
      }
    });

    qualitySelect.addEventListener('change', () => {
      state.audioQuality = qualitySelect.value;
      saveState();
    });

    videoQualitySelect.addEventListener('change', () => {
      state.videoQuality = videoQualitySelect.value;
      saveState();
    });

    videoPremuxedToggle.addEventListener('change', () => {
      state.videoPremuxed = videoPremuxedToggle.checked;
      videoQualitySelect.disabled = state.videoPremuxed;
      saveState();
    });

    animationsToggle.addEventListener('change', () => {
      state.animations = animationsToggle.checked;
      document.documentElement.classList.toggle('no-animations', !state.animations);
      saveState();
    });

    effectsToggle.addEventListener('change', () => {
      state.effects = effectsToggle.checked;
      document.documentElement.classList.toggle('no-effects', !state.effects);
      saveState();
    });

    countrySelect.addEventListener('change', () => {
      state.country = countrySelect.value;
      window.snowify.setCountry(state.country);
      // Invalidate explore caches so next visit fetches localized data
      _exploreCache = null;
      _chartsCache = null;
      _exploreCacheTime = 0;
      _chartsCacheTime = 0;
      saveState();
      showToast(state.country ? `Explore region set to ${countrySelect.options[countrySelect.selectedIndex].text}` : 'Explore region cleared');
    });

    $('#setting-clear-history').addEventListener('click', () => {
      if (confirm('Clear play history?')) {
        state.recentTracks = [];
        saveState();
        renderHome();
        showToast('Play history cleared');
      }
    });

    $('#setting-clear-search-history').addEventListener('click', () => {
      if (confirm('Clear search history?')) {
        state.searchHistory = [];
        saveState();
        showToast('Search history cleared');
      }
    });

    $('#setting-reset-all').addEventListener('click', () => {
      if (confirm('Reset ALL data? This will delete all playlists, liked songs, and settings.')) {
        localStorage.removeItem('snowify_state');
        location.reload();
      }
    });

    // Account buttons
    $('#btn-sign-in').addEventListener('click', async () => {
      const email = $('#auth-email').value.trim();
      const password = $('#auth-password').value;
      const errorEl = $('#auth-error');
      errorEl.classList.add('hidden');
      if (!email || !password) {
        errorEl.textContent = 'Please enter email and password';
        errorEl.classList.remove('hidden');
        return;
      }
      const result = await window.snowify.signInWithEmail(email, password);
      if (result?.error) {
        errorEl.textContent = result.error;
        errorEl.classList.remove('hidden');
      } else {
        showToast('Signed in successfully');
      }
    });

    $('#btn-sign-up').addEventListener('click', async () => {
      const email = $('#auth-email').value.trim();
      const password = $('#auth-password').value;
      const errorEl = $('#auth-error');
      errorEl.classList.add('hidden');
      if (!email || !password) {
        errorEl.textContent = 'Please enter email and password';
        errorEl.classList.remove('hidden');
        return;
      }
      if (password.length < 6) {
        errorEl.textContent = 'Password must be at least 6 characters';
        errorEl.classList.remove('hidden');
        return;
      }
      const result = await window.snowify.signUpWithEmail(email, password);
      if (result?.error) {
        errorEl.textContent = result.error;
        errorEl.classList.remove('hidden');
      } else {
        showToast('Account created & signed in');
      }
    });

    $('#btn-sign-out').addEventListener('click', async () => {
      await window.snowify.authSignOut();
      showToast('Signed out');
    });

    $('#btn-sync-now').addEventListener('click', async () => {
      updateSyncStatus('Syncing...');
      await cloudLoadAndMerge({ forceCloud: true });
      await forceCloudSave();
      updateSyncStatus('Synced just now');
    });

    // ── Profile editing ──
    $('#btn-edit-name').addEventListener('click', () => {
      const row = $('#profile-edit-name-row');
      const input = $('#profile-name-input');
      row.classList.remove('hidden');
      input.value = $('#profile-display-name').textContent;
      input.focus();
      input.select();
    });

    $('#btn-cancel-name').addEventListener('click', () => {
      $('#profile-edit-name-row').classList.add('hidden');
    });

    $('#btn-save-name').addEventListener('click', async () => {
      const input = $('#profile-name-input');
      const name = input.value.trim();
      if (!name) return;
      const result = await window.snowify.updateProfile({ displayName: name });
      if (result?.error) {
        showToast('Failed to update name');
      } else {
        $('#profile-display-name').textContent = name;
        $('#profile-avatar').src = result.photoURL || generateDefaultAvatar(name);
        $('#profile-edit-name-row').classList.add('hidden');
        showToast('Display name updated');
      }
    });

    $('#profile-name-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btn-save-name').click();
      if (e.key === 'Escape') $('#btn-cancel-name').click();
    });

    $('#btn-change-avatar').addEventListener('click', async () => {
      const filePath = await window.snowify.pickImage();
      if (!filePath) return;
      try {
        const dataUrl = await window.snowify.readImage(filePath);
        if (!dataUrl) { showToast('Failed to load image'); return; }
        // Resize to 128×128 to keep the data URL small for Firebase
        const img = new Image();
        img.onload = async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 128;
          canvas.height = 128;
          const ctx = canvas.getContext('2d');
          const size = Math.min(img.width, img.height);
          const sx = (img.width - size) / 2;
          const sy = (img.height - size) / 2;
          ctx.drawImage(img, sx, sy, size, size, 0, 0, 128, 128);
          const resized = canvas.toDataURL('image/jpeg', 0.8);
          const updateResult = await window.snowify.updateProfile({ photoURL: resized });
          if (updateResult?.error) {
            showToast('Failed to update avatar');
          } else {
            $('#profile-avatar').src = resized;
            showToast('Profile picture updated');
          }
        };
        img.src = dataUrl;
      } catch (_) {
        showToast('Failed to load image');
      }
    });

    // Check initial auth state
    const user = await window.snowify.getUser();
    if (user) updateAccountUI(user);
  }

  init();
})();
