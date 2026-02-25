(() => {
  'use strict';

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  // ─── Generic slider tooltip ───
  function setupSliderTooltip(sliderEl, formatValue) {
    const tip = document.createElement('div');
    tip.className = 'slider-tooltip';
    sliderEl.style.position = 'relative';
    sliderEl.appendChild(tip);
    sliderEl.addEventListener('mouseenter', () => tip.classList.add('visible'));
    sliderEl.addEventListener('mouseleave', () => tip.classList.remove('visible'));
    sliderEl.addEventListener('mousemove', (e) => {
      const rect = sliderEl.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      tip.textContent = formatValue(pct);
      tip.style.left = (pct * rect.width) + 'px';
    });
  }

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
    playingPlaylistId: null,
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

  // ─── Save button SVGs ───
  const SAVE_SVG_CHECK = '<span class="save-burst"></span><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const SAVE_SVG_PLUS = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  // ─── Custom Theme Helpers ───
  const BUILTIN_THEMES = ['dark', 'light', 'ocean', 'forest', 'sunset', 'rose', 'midnight'];

  function isCustomTheme(theme) {
    return theme && theme.startsWith('custom:');
  }

  function customThemeId(theme) {
    return theme.slice('custom:'.length);
  }

  function applyCustomThemeCss(css) {
    // Remove existing to force full re-parse (including @import)
    removeCustomThemeCss();
    const el = document.createElement('style');
    el.id = 'custom-theme-style';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function removeCustomThemeCss() {
    const el = document.getElementById('custom-theme-style');
    if (el) el.remove();
  }

  async function loadAndApplyThemeFile(themeValue) {
    if (!isCustomTheme(themeValue)) { removeCustomThemeCss(); return false; }
    const css = await window.snowify.loadTheme(customThemeId(themeValue));
    if (css) { applyCustomThemeCss(css); return true; }
    removeCustomThemeCss();
    return false;
  }

  async function populateCustomThemes(selectEl, currentValue) {
    // Remove old custom options
    selectEl.querySelectorAll('option[data-custom]').forEach(o => o.remove());
    const themes = await window.snowify.scanThemes();
    if (themes.length) {
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = '── Custom ──';
      sep.dataset.custom = '1';
      selectEl.appendChild(sep);
      for (const t of themes) {
        const opt = document.createElement('option');
        opt.value = 'custom:' + t.id;
        opt.textContent = t.name;
        opt.dataset.custom = '1';
        selectEl.appendChild(opt);
      }
    }
    selectEl.value = currentValue;
    // If the value didn't match (theme was removed), fall back to dark
    if (selectEl.value !== currentValue && isCustomTheme(currentValue)) {
      selectEl.value = 'dark';
    }
  }

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
    // Queue persistence (local-only, not synced to cloud)
    localStorage.setItem('snowify_queue', JSON.stringify({
      queue: state.queue,
      originalQueue: state.originalQueue,
      queueIndex: state.queueIndex,
      playingPlaylistId: state.playingPlaylistId
    }));
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
      // Restore queue (local-only, separate from cloud sync)
      const savedQueue = JSON.parse(localStorage.getItem('snowify_queue'));
      if (savedQueue) {
        state.queue = savedQueue.queue || [];
        state.originalQueue = savedQueue.originalQueue || [];
        state.queueIndex = savedQueue.queueIndex ?? -1;
        state.playingPlaylistId = savedQueue.playingPlaylistId || null;
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
  const NOW_PLAYING_ICON_SVG = '<svg class="now-playing-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.016 1.125A.75.75 0 0 0 8.99.85l-4.2 3.43H1.75A.75.75 0 0 0 1 5.03v5.94a.75.75 0 0 0 .75.75h3.04l4.2 3.43a.75.75 0 0 0 1.026-.275.75.75 0 0 0 .1-.375V1.5a.75.75 0 0 0-.1-.375z"/><path class="sound-wave wave-1" opacity="0" d="M12.25 3.17a.75.75 0 0 0-.917 1.19 3.56 3.56 0 0 1 0 7.28.75.75 0 0 0 .918 1.19 5.06 5.06 0 0 0 0-9.66z"/><path class="sound-wave wave-2" opacity="0" d="M14.2 1.5a.75.75 0 0 0-.917 1.19 5.96 5.96 0 0 1 0 10.62.75.75 0 0 0 .918 1.19 7.46 7.46 0 0 0 0-13z"/></svg>';
  const NOW_PLAYING_EQ_HTML = '<div class="track-eq"><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span></div>';
  const ICON_BROKEN_HEART = '<svg width="20" height="20" viewBox="0 0 24 24" fill="var(--accent)"><path d="M2 8.5C2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09V21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5z"/><path d="M12 5.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35V5.09z" transform="translate(1.5, 2) rotate(8, 12, 12)"/></svg>';

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
        <p>Search for songs, artists, albums, or playlists</p>
      </div>`;
  }

  async function performSearch(query) {
    searchResults.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
    try {
      const [results, artists, albums, playlists, videos] = await Promise.all([
        window.snowify.search(query, state.musicOnly),
        window.snowify.searchArtists(query),
        window.snowify.searchAlbums(query),
        window.snowify.searchPlaylists(query),
        window.snowify.searchVideos(query)
      ]);

      if (!results.length && !artists.length && !albums.length && !playlists.length && !videos.length) {
        searchResults.innerHTML = `
          <div class="empty-state">
            <p>No results found for "${escapeHtml(query)}"</p>
          </div>`;
        return;
      }

      searchResults.innerHTML = '';

      if (artists.length) renderSearchArtists(artists.slice(0, 3));
      if (results.length) renderSearchSongs(results.slice(0, 10));
      if (albums.length) renderSearchAlbums(albums);
      if (playlists.length) renderSearchPlaylists(playlists);
      if (videos.length) renderSearchVideos(videos);
    } catch (err) {
      searchResults.innerHTML = `<div class="empty-state"><p>Search failed. Please try again.</p></div>`;
    }
  }

  function renderSearchArtists(artists) {
    const section = document.createElement('div');
    section.innerHTML = `<h3 class="search-section-header">Artists</h3>`;
    const scroll = document.createElement('div');
    scroll.className = 'similar-artists-scroll';
    scroll.innerHTML = artists.map((a, i) => `
      <div class="search-artist-card${i === 0 ? ' search-artist-top' : ''}" data-artist-id="${escapeHtml(a.artistId)}">
        <img class="search-artist-avatar" src="${escapeHtml(a.thumbnail || '')}" alt="" loading="lazy" />
        <div class="search-artist-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
        <div class="search-artist-label">Artist</div>
      </div>
    `).join('');
    section.appendChild(scroll);
    searchResults.appendChild(section);
    scroll.querySelectorAll('.search-artist-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.artistId;
        if (id) openArtistPage(id);
      });
    });
  }

  function renderSearchAlbums(albums) {
    const section = document.createElement('div');
    section.innerHTML = `<h3 class="search-section-header">Albums</h3>`;
    const scroll = document.createElement('div');
    scroll.className = 'album-scroll';
    scroll.innerHTML = albums.map(a => `
      <div class="album-card" data-album-id="${escapeHtml(a.albumId)}">
        <img class="album-card-cover" src="${escapeHtml(a.thumbnail)}" alt="" loading="lazy" />
        <button class="album-card-play" title="Play">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
        </button>
        <div class="album-card-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>
        <div class="album-card-meta">${escapeHtml(a.artist || '')}${a.year ? ' \u00B7 ' + a.year : ''}</div>
      </div>
    `).join('');
    section.appendChild(scroll);
    searchResults.appendChild(section);
    addScrollArrows(scroll);
    scroll.querySelectorAll('.album-card').forEach(card => {
      const albumId = card.dataset.albumId;
      const meta = albums.find(al => al.albumId === albumId);
      card.querySelector('.album-card-play').addEventListener('click', async (e) => {
        e.stopPropagation();
        const album = await window.snowify.albumTracks(albumId);
        if (album && album.tracks.length) playFromList(album.tracks, 0);
        else showToast('Could not load album');
      });
      card.addEventListener('click', () => showAlbumDetail(albumId, meta));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showAlbumContextMenu(e, albumId, meta);
      });
    });
  }

  function renderSearchPlaylists(playlists) {
    const section = document.createElement('div');
    section.innerHTML = `<h3 class="search-section-header">Playlists</h3>`;
    const scroll = document.createElement('div');
    scroll.className = 'album-scroll';
    scroll.innerHTML = playlists.map(p => `
      <div class="album-card" data-playlist-id="${escapeHtml(p.playlistId)}">
        <img class="album-card-cover" src="${escapeHtml(p.thumbnail)}" alt="" loading="lazy" />
        <button class="album-card-play" title="Play">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
        </button>
        <div class="album-card-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
        <div class="album-card-meta">${escapeHtml(p.author || '')}</div>
      </div>
    `).join('');
    section.appendChild(scroll);
    searchResults.appendChild(section);
    addScrollArrows(scroll);
    scroll.querySelectorAll('.album-card').forEach(card => {
      const pid = card.dataset.playlistId;
      const meta = playlists.find(pl => pl.playlistId === pid);
      card.querySelector('.album-card-play').addEventListener('click', async (e) => {
        e.stopPropagation();
        const tracks = await window.snowify.getPlaylistVideos(pid);
        if (tracks && tracks.length) playFromList(tracks, 0);
        else showToast('Could not load playlist');
      });
      card.addEventListener('click', () => showExternalPlaylistDetail(pid, meta));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showPlaylistContextMenu(e, pid, meta);
      });
    });
  }

  function renderSearchVideos(videos) {
    const section = document.createElement('div');
    section.innerHTML = `<h3 class="search-section-header">Videos</h3>`;
    const scroll = document.createElement('div');
    scroll.className = 'album-scroll';
    scroll.innerHTML = videos.map(v => `
      <div class="video-card" data-video-id="${escapeHtml(v.id)}">
        <img class="video-card-thumb" src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy" />
        <button class="video-card-play" title="Watch">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
        </button>
        <div class="video-card-name" title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</div>
        ${v.duration ? `<div class="video-card-duration">${escapeHtml(v.duration)}</div>` : ''}
      </div>
    `).join('');
    section.appendChild(scroll);
    searchResults.appendChild(section);
    addScrollArrows(scroll);
    scroll.querySelectorAll('.video-card').forEach(card => {
      const vid = card.dataset.videoId;
      const video = videos.find(v => v.id === vid);
      card.addEventListener('click', () => {
        if (video) openVideoPlayer(video.id, video.title, video.artist);
      });
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (video) showVideoContextMenu(e, video);
      });
    });
  }

  function renderSearchSongs(results) {
    const songsHeader = document.createElement('div');
    songsHeader.innerHTML = `<h3 class="search-section-header">Songs</h3>`;
    searchResults.appendChild(songsHeader);

    const tracksWrapper = document.createElement('div');
    searchResults.appendChild(tracksWrapper);
    renderTrackList(tracksWrapper, results, 'search');
  }

  function renderTrackList(container, tracks, context, sourcePlaylistId = null) {
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
      const isPlaying = state.queue[state.queueIndex]?.id === track.id;
      const isLiked = state.likedSongs.some(t => t.id === track.id);

      html += `
        <div class="track-row ${isPlaying ? 'playing' : ''}${modifier}"
             data-track-id="${track.id}" data-context="${context}" data-index="${i}" draggable="true">
          <div class="track-num">
            <span class="track-num-text">${i + 1}</span>
            ${NOW_PLAYING_EQ_HTML}
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
      row.addEventListener('click', () => playFromList(tracks, idx, sourcePlaylistId));
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
          else spawnBrokenHeart(likeBtn);
        });
      }
    });

    bindArtistLinks(container);
  }

  function buildPlaylistSectionHtml() {
    if (state.playlists.length >= 5) {
      const subItems = state.playlists.map(p =>
        `<div class="context-menu-item context-sub-item" data-action="add-to-playlist" data-pid="${p.id}">${escapeHtml(p.name)}</div>`
      ).join('');
      return `
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
      return '<div class="context-menu-divider"></div>' + inlineItems;
    }
    return '';
  }

  function positionContextMenu(menu) {
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

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
  }

  function showContextMenu(e, track, { hideAddQueue = false, hidePlayNext = false } = {}) {
    removeContextMenu();
    const isLiked = state.likedSongs.some(t => t.id === track.id);
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    const playlistSection = buildPlaylistSectionHtml();
    const addQueueHtml = hideAddQueue ? '' : '<div class="context-menu-item" data-action="add-queue">Add to Queue</div>';
    const playNextHtml = hidePlayNext ? '' : '<div class="context-menu-item" data-action="play-next">Play Next</div>';

    menu.innerHTML = `
      <div class="context-menu-item" data-action="play">Play</div>
      ${playNextHtml}
      ${addQueueHtml}
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="start-radio">Start Radio</div>
      <div class="context-menu-item" data-action="watch-video">Watch Video</div>
      <div class="context-menu-item" data-action="like">${isLiked ? 'Unlike' : 'Like'}</div>
      ${playlistSection}
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="share">Copy Link</div>
    `;

    positionContextMenu(menu);

    menu.addEventListener('click', async (ev) => {
      const item = ev.target.closest('[data-action]');
      if (!item) return;
      const action = item.dataset.action;
      if (action === 'none') return;
      switch (action) {
        case 'play':
          state.playingPlaylistId = null;
          playTrack(track);
          updatePlaylistHighlight();
          break;
        case 'play-next': handlePlayNext(track); break;
        case 'add-queue': handleAddToQueue(track); break;
        case 'watch-video':
          openVideoPlayer(track.id, track.title, track.artist);
          break;
        case 'start-radio': {
          const upNexts = await window.snowify.getUpNexts(track.id);
          if (upNexts.length) {
            playFromList([track, ...upNexts.filter(t => t.id !== track.id)], 0);
            showToast('Radio started');
          } else {
            showToast('Could not start radio');
          }
          break;
        }
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

  // ─── Generic save button setup (reused by album + playlist detail views) ───
  function setupSaveButton(saveBtn, externalId, displayName, tracks) {
    const updateSaveBtn = (animate) => {
      const isSaved = state.playlists.some(p => p.externalId === externalId);
      saveBtn.title = isSaved ? 'Remove from library' : 'Save to library';
      saveBtn.classList.toggle('saved', isSaved);
      saveBtn.innerHTML = isSaved ? SAVE_SVG_CHECK : SAVE_SVG_PLUS;
      if (animate === 'save') {
        saveBtn.classList.add('saving');
        saveBtn.addEventListener('animationend', () => saveBtn.classList.remove('saving'), { once: true });
      }
    };

    saveBtn.style.display = '';
    saveBtn.classList.remove('saving', 'unsaving');
    updateSaveBtn();

    saveBtn.onclick = () => {
      const existing = state.playlists.find(p => p.externalId === externalId);
      if (existing) {
        state.playlists = state.playlists.filter(p => p.externalId !== externalId);
        saveBtn.classList.add('unsaving');
        saveBtn.addEventListener('animationend', () => {
          saveBtn.classList.remove('unsaving');
          updateSaveBtn();
        }, { once: true });
        showToast(`Removed "${displayName}" from library`);
      } else {
        const pl = createPlaylist(displayName);
        pl.externalId = externalId;
        pl.tracks = tracks;
        updateSaveBtn('save');
        showToast(`Saved "${displayName}" with ${tracks.length} songs`);
      }
      saveState();
      renderPlaylists();
    };
  }

  // ─── Generic context menu for albums + playlists ───
  function showCollectionContextMenu(e, externalId, meta, options) {
    const { loadTracks, fallbackName = 'Playlist', playLabel = 'Play All', errorMsg = 'Could not load tracks', copyLink = null } = options;
    removeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    const saved = state.playlists.find(p => p.externalId === externalId);

    menu.innerHTML = `
      <div class="context-menu-item" data-action="play">${playLabel}</div>
      <div class="context-menu-item" data-action="shuffle">Shuffle Play</div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="${saved ? 'remove' : 'save'}">${saved ? 'Remove from library' : 'Save as Playlist'}</div>
      ${copyLink ? '<div class="context-menu-item" data-action="share">Copy Link</div>' : ''}
    `;

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    menu.addEventListener('click', async (ev) => {
      const item = ev.target.closest('.context-menu-item');
      if (!item) return;
      const action = item.dataset.action;

      if (action === 'remove') {
        state.playlists = state.playlists.filter(p => p.externalId !== externalId);
        saveState();
        renderPlaylists();
        showToast(`Removed "${meta?.name || fallbackName}" from library`);
      } else if (action === 'share' && copyLink) {
        navigator.clipboard.writeText(copyLink);
        showToast('Link copied to clipboard');
      } else if (action === 'play' || action === 'shuffle' || action === 'save') {
        const tracks = await loadTracks();
        if (!tracks?.length) { showToast(errorMsg); removeContextMenu(); return; }

        if (action === 'play') {
          playFromList(tracks, 0);
        } else if (action === 'shuffle') {
          playFromList([...tracks].sort(() => Math.random() - 0.5), 0);
        } else if (action === 'save') {
          const name = meta?.name || fallbackName;
          const pl = createPlaylist(name);
          pl.externalId = externalId;
          pl.tracks = tracks;
          saveState();
          renderPlaylists();
          showToast(`Saved "${name}" with ${tracks.length} songs`);
        }
      }
      removeContextMenu();
    });

    setTimeout(() => {
      document.addEventListener('click', removeContextMenu, { once: true });
    }, 10);
  }

  // Thin wrappers to keep existing call sites unchanged
  function showAlbumContextMenu(e, albumId, meta) {
    showCollectionContextMenu(e, albumId, meta, {
      loadTracks: async () => { const a = await window.snowify.albumTracks(albumId); return a?.tracks || []; },
      fallbackName: 'Album',
      playLabel: 'Play All',
      errorMsg: 'Could not load album',
      copyLink: `https://music.youtube.com/browse/${albumId}`
    });
  }

  function showPlaylistContextMenu(e, playlistId, meta) {
    showCollectionContextMenu(e, playlistId, meta, {
      loadTracks: () => window.snowify.getPlaylistVideos(playlistId),
      fallbackName: 'Imported Playlist',
      playLabel: 'Play',
      errorMsg: 'Could not load playlist'
    });
  }

  async function playTrack(track) {
    state.isLoading = true;
    updatePlayButton();
    showNowPlaying(track);
    showToast(`Loading: ${track.title}`);

    try {
      const directUrl = await window.snowify.getStreamUrl(track.url, state.audioQuality);
      audio.src = directUrl;
      audio.volume = state.volume * VOLUME_SCALE;
      audio.load();
      await audio.play();
      state.isPlaying = true;
      state.isLoading = false;
      addToRecent(track);
      updateDiscordPresence(track);
      renderQueue();
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

  const PLAY_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#000"><path d="M8 5v14l11-7L8 5z"/></svg>';
  const PAUSE_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#000"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>';

  function isCollectionPlaying(tracks, sourcePlaylistId) {
    if (!state.queue.length || !tracks.length) return false;
    // For playlists with a known ID, compare IDs
    if (sourcePlaylistId && state.playingPlaylistId === sourcePlaylistId) return true;
    // For albums/external playlists, compare first track
    if (!sourcePlaylistId && state.queue[0]?.id === tracks[0]?.id && state.queue.length === tracks.length) return true;
    return false;
  }

  function updatePlayAllBtn(btn, tracks, sourcePlaylistId) {
    if (!btn) return;
    const playing = isCollectionPlaying(tracks, sourcePlaylistId) && state.isPlaying;
    btn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    btn.title = playing ? 'Pause' : 'Play all';
  }

  function playFromList(tracks, index, sourcePlaylistId = null) {
    state.playingPlaylistId = sourcePlaylistId;
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
    updatePlaylistHighlight();
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
      state.playingPlaylistId = null;
      updatePlaylistHighlight();
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
      renderQueue();
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
    // Restored queue but audio not loaded yet — load and play from start
    if (!audio.src) {
      const track = state.queue[state.queueIndex];
      if (!track) return;
      playTrack(track);
      return;
    }
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

  setupSliderTooltip(progressBar, (pct) => formatTime(pct * (audio.duration || 0)));

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
    audio.volume = state.volume * VOLUME_SCALE;
    if (_videoAudio) _videoAudio.volume = state.volume * VOLUME_SCALE;
    if (videoPlayer && !videoPlayer.muted) videoPlayer.volume = state.volume * VOLUME_SCALE;
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
    document.body.classList.toggle('audio-playing', state.isPlaying);
    if (window.snowify.updateThumbar) window.snowify.updateThumbar(state.isPlaying);
    // Sync play-all buttons on visible views
    syncViewPlayAllBtns();
  }

  function syncViewPlayAllBtns() {
    const playAllBtn = $('#btn-play-all');
    const albumPlayBtn = $('#btn-album-play-all');
    const artistPlayBtn = $('#btn-artist-play-all');
    if (playAllBtn) {
      const playing = state.playingPlaylistId && state.playingPlaylistId === state.currentPlaylistId && state.isPlaying;
      playAllBtn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
      playAllBtn.title = playing ? 'Pause' : 'Play all';
    }
    if (albumPlayBtn) {
      const isActive = state.queue.length > 0 && !state.playingPlaylistId && state.isPlaying;
      albumPlayBtn.innerHTML = isActive ? PAUSE_SVG : PLAY_SVG;
      albumPlayBtn.title = isActive ? 'Pause' : 'Play all';
    }
    if (artistPlayBtn) {
      const isActive = state.queue.length > 0 && !state.playingPlaylistId && state.isPlaying;
      artistPlayBtn.innerHTML = isActive ? PAUSE_SVG : PLAY_SVG;
      artistPlayBtn.title = isActive ? 'Pause' : 'Play all';
    }
  }

  function updateTrackHighlight() {
    $$('.track-row').forEach(row => {
      const current = state.queue[state.queueIndex];
      row.classList.toggle('playing', current && row.dataset.trackId === current.id);
    });
    updatePlaylistHighlight();
  }

  function updatePlaylistHighlight() {
    $$('.playlist-item').forEach(item => {
      const isPlaying = state.playingPlaylistId != null && item.dataset.playlist === state.playingPlaylistId;
      const wasPlaying = item.classList.contains('playing');
      item.classList.toggle('playing', isPlaying);
      if (isPlaying && !wasPlaying) {
        const icon = item.querySelector('.now-playing-icon');
        if (icon) {
          icon.classList.remove('animate-waves');
          void icon.offsetWidth; // force reflow to restart CSS animation
          icon.classList.add('animate-waves');
        }
      }
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

  // Windows taskbar thumbbar buttons
  if (window.snowify.onThumbarPrev) {
    window.snowify.onThumbarPrev(() => playPrev());
    window.snowify.onThumbarPlayPause(() => togglePlay());
    window.snowify.onThumbarNext(() => playNext());
  }

  const npLike = $('#np-like');
  npLike.addEventListener('click', () => {
    const track = state.queue[state.queueIndex];
    if (track) {
      const wasLiked = toggleLike(track);
      if (wasLiked) spawnHeartParticles(npLike);
      else spawnBrokenHeart(npLike);
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
      const liked = state.likedSongs.some(t => t.id === track.id);
      npLike.classList.toggle('liked', liked);
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

  function spawnBrokenHeart(originEl) {
    const rect = originEl.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'broken-heart';
    el.innerHTML = ICON_BROKEN_HEART;
    el.style.left = rect.left + rect.width / 2 + 'px';
    el.style.top = rect.top + rect.height / 2 + 'px';
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
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
      // Convert native path to proper file:// URL (handles Windows backslashes)
      const normalized = playlist.coverImage.replace(/\\/g, '/');
      const fileUrl = normalized.startsWith('/') ? `file://${encodeURI(normalized)}` : `file:///${encodeURI(normalized)}`;
      return `<img src="${fileUrl}" alt="" />`;
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
        ${NOW_PLAYING_ICON_SVG}
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
          ${NOW_PLAYING_ICON_SVG}
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
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const pid = item.dataset.playlist;
        if (pid === 'liked') {
          showSidebarPlaylistMenu(e, { id: 'liked', name: 'Liked Songs', tracks: state.likedSongs }, true);
        } else {
          const pl = state.playlists.find(p => p.id === pid);
          if (pl) showSidebarPlaylistMenu(e, pl, false);
        }
      });

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
    updatePlaylistHighlight();
  }

  function showSidebarPlaylistMenu(e, playlist, isLiked = false) {
    removeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    const manageHtml = isLiked ? '' : `
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="change-cover">Change cover</div>
      ${playlist.coverImage ? '<div class="context-menu-item" data-action="remove-cover">Remove cover</div>' : ''}
      <div class="context-menu-item" data-action="rename">Rename</div>
      <div class="context-menu-item" data-action="delete" style="color:var(--red)">Delete</div>`;

    menu.innerHTML = `
      <div class="context-menu-item" data-action="play">Play</div>
      <div class="context-menu-item" data-action="shuffle">Shuffle play</div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="export-csv">Export as CSV</div>
      ${manageHtml}
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
          if (playlist.tracks.length) playFromList(playlist.tracks, 0, playlist.id);
          else showToast('Playlist is empty');
          break;
        case 'shuffle':
          if (playlist.tracks.length) {
            const shuffled = [...playlist.tracks];
            for (let i = shuffled.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            playFromList(shuffled, 0, playlist.id);
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
        case 'export-csv': {
          removeContextMenu();
          if (!playlist.tracks.length) { showToast('Playlist is empty'); return; }
          const ok = await window.snowify.exportPlaylistCsv(playlist.name, playlist.tracks);
          if (ok) showToast('Playlist exported successfully');
          return;
        }
        case 'delete':
          if (confirm(`Delete "${playlist.name}"?`)) {
            if (playlist.coverImage) window.snowify.deleteImage(playlist.coverImage);
            state.playlists = state.playlists.filter(p => p.id !== playlist.id);
            if (state.playingPlaylistId === playlist.id) state.playingPlaylistId = null;
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
    const exportBtn = $('#btn-export-playlist');
    renameBtn.style.display = isLiked ? 'none' : '';
    deleteBtn.style.display = isLiked ? 'none' : '';
    coverBtn.style.display = isLiked ? 'none' : '';

    if (playlist.tracks.length) {
      renderTrackList(tracksContainer, playlist.tracks, 'playlist', playlist.id);

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

    const playAllBtn = $('#btn-play-all');
    updatePlayAllBtn(playAllBtn, playlist.tracks, playlist.id);
    playAllBtn.onclick = () => {
      if (!playlist.tracks.length) return;
      if (isCollectionPlaying(playlist.tracks, playlist.id)) {
        togglePlay();
        updatePlayAllBtn(playAllBtn, playlist.tracks, playlist.id);
      } else {
        playFromList(playlist.tracks, 0, playlist.id);
        updatePlayAllBtn(playAllBtn, playlist.tracks, playlist.id);
      }
    };

    $('#btn-shuffle-playlist').onclick = () => {
      if (playlist.tracks.length) {
        const shuffled = [...playlist.tracks];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        playFromList(shuffled, 0, playlist.id);
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

    exportBtn.onclick = async () => {
      if (!playlist.tracks.length) return showToast('Playlist is empty');
      const ok = await window.snowify.exportPlaylistCsv(playlist.name, playlist.tracks);
      if (ok) showToast('Playlist exported successfully');
    };

    deleteBtn.onclick = () => {
      if (isLiked) return;
      if (confirm(`Delete "${playlist.name}"?\nThis cannot be undone.`)) {
        if (playlist.coverImage) window.snowify.deleteImage(playlist.coverImage);
        state.playlists = state.playlists.filter(p => p.id !== playlist.id);
        if (state.playingPlaylistId === playlist.id) state.playingPlaylistId = null;
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
      <div class="context-menu-item" data-action="start-radio">Start Radio</div>
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

    menu.addEventListener('click', async (ev) => {
      const item = ev.target.closest('.context-menu-item');
      if (!item) return;
      const action = item.dataset.action;
      switch (action) {
        case 'play':
          state.playingPlaylistId = null;
          playTrack(track);
          updatePlaylistHighlight();
          break;
        case 'play-next': handlePlayNext(track); break;
        case 'add-queue': handleAddToQueue(track); break;
        case 'like': toggleLike(track); break;
        case 'start-radio': {
          const upNexts = await window.snowify.getUpNexts(track.id);
          if (upNexts.length) {
            playFromList([track, ...upNexts.filter(t => t.id !== track.id)], 0);
            showToast('Radio started');
          } else {
            showToast('Could not start radio');
          }
          break;
        }
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

  function handlePlayNext(track) {
    const existIdx = state.queue.findIndex((t, i) => i > state.queueIndex && t.id === track.id);
    if (existIdx !== -1) state.queue.splice(existIdx, 1);
    if (state.queueIndex >= 0) state.queue.splice(state.queueIndex + 1, 0, track);
    else state.queue.push(track);
    showToast(existIdx !== -1 ? 'Moved to play next' : 'Added to play next');
    renderQueue();
  }

  function handleAddToQueue(track) {
    if (state.queue.slice(state.queueIndex + 1).some(t => t.id === track.id)) {
      showToast('Already in queue');
    } else {
      state.queue.push(track);
      showToast('Added to queue');
      renderQueue();
    }
  }

  function renderNowPlayingSection(container) {
    const current = state.queue[state.queueIndex];
    if (current) {
      container.innerHTML = renderQueueItem(current, true, false);
      const nowItem = container.querySelector('.queue-item');
      if (nowItem) {
        bindArtistLinks(nowItem);
        nowItem.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showContextMenu(e, current, { hideAddQueue: true, hidePlayNext: true });
        });
      }
    } else {
      container.innerHTML = `<p style="color:var(--text-subdued);font-size:13px;">Nothing playing</p>`;
    }
  }

  const queuePanel = $('#queue-panel');
  let _queueActiveTab = 'queue';

  $('#btn-queue').addEventListener('click', () => {
    queuePanel.classList.toggle('hidden');
    queuePanel.classList.toggle('visible');
    // Always reset to Queue tab when opening
    _queueActiveTab = 'queue';
    switchQueueTab('queue');
    renderQueue();
  });
  $('#btn-close-queue').addEventListener('click', () => {
    queuePanel.classList.add('hidden');
    queuePanel.classList.remove('visible');
  });

  // Tab switching
  $$('.queue-tab', queuePanel).forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      if (target === _queueActiveTab) return;
      _queueActiveTab = target;
      switchQueueTab(target);
    });
  });

  function switchQueueTab(tab) {
    $$('.queue-tab', queuePanel).forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $('#queue-view').style.display = tab === 'queue' ? '' : 'none';
    $('#history-view').style.display = tab === 'history' ? '' : 'none';
    if (tab === 'history') renderHistory();
  }

  // Clear queue
  $('#btn-clear-queue').addEventListener('click', () => {
    state.queue = state.queue.slice(0, state.queueIndex + 1);
    const remainingIds = new Set(state.queue.map(t => t.id));
    state.originalQueue = state.originalQueue.filter(t => remainingIds.has(t.id));
    renderQueue();
    saveState();
    showToast('Queue cleared');
  });

  // Clear history
  $('#btn-clear-history').addEventListener('click', () => {
    state.recentTracks = [];
    saveState();
    renderHistory();
    renderRecentTracks();
    renderQuickPicks();
    showToast('History cleared');
  });

  function renderQueue() {
    const nowPlaying = $('#queue-now-playing');
    const upNext = $('#queue-up-next');
    const clearBtn = $('#btn-clear-queue');

    renderNowPlayingSection(nowPlaying);

    const upcoming = state.queue.slice(state.queueIndex + 1);
    clearBtn.style.display = upcoming.length ? '' : 'none';

    if (upcoming.length) {
      upNext.innerHTML = upcoming.map((t, i) => {
        const queueIdx = state.queueIndex + 1 + i;
        return renderQueueItem(t, false, true, queueIdx);
      }).join('');

      upNext.querySelectorAll('.queue-item').forEach(item => {
        const idx = parseInt(item.dataset.queueIndex, 10);
        const track = state.queue[idx];
        if (!track) return;

        bindArtistLinks(item);

        // Click to jump to track
        item.addEventListener('click', (e) => {
          if (e.target.closest('.queue-item-remove') || e.target.closest('a')) return;
          state.queueIndex = idx;
          playTrack(state.queue[idx]);
          renderQueue();
        });

        // Right-click context menu
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const isNext = idx === state.queueIndex + 1;
          showContextMenu(e, track, { hideAddQueue: true, hidePlayNext: isNext });
        });

        // Remove button
        const removeBtn = item.querySelector('.queue-item-remove');
        if (removeBtn) {
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.queue.splice(idx, 1);
            state.originalQueue = state.originalQueue.filter(t => t.id !== track.id || state.queue.some(q => q.id === t.id));
            renderQueue();
            saveState();
          });
        }
      });

      bindQueueDragReorder();
    } else {
      upNext.innerHTML = `<p style="color:var(--text-subdued);font-size:13px;">Queue is empty</p>`;
    }
  }

  function renderQueueItem(track, isActive, showRemove, queueIndex) {
    const removeHtml = showRemove ? `
      <button class="queue-item-remove" title="Remove from queue">
        <svg width="14" height="14" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>` : '';
    const indexAttr = queueIndex !== undefined ? ` data-queue-index="${queueIndex}"` : '';
    const draggable = showRemove ? ' draggable="true"' : '';
    return `
      <div class="queue-item ${isActive ? 'active' : ''}" data-track-id="${track.id}"${indexAttr}${draggable}>
        <img src="${escapeHtml(track.thumbnail)}" alt="" />
        <div class="queue-item-info">
          <div class="queue-item-title">${escapeHtml(track.title)}</div>
          <div class="queue-item-artist">${renderArtistLinks(track)}</div>
        </div>
        ${removeHtml}
      </div>`;
  }

  function renderHistory() {
    renderNowPlayingSection($('#history-now-playing'));

    // Recently Played list
    const container = $('#history-list');
    $('#btn-clear-history').style.display = state.recentTracks.length ? '' : 'none';
    if (!state.recentTracks.length) {
      container.innerHTML = `<p style="color:var(--text-subdued);font-size:13px;">No recently played tracks</p>`;
      return;
    }
    container.innerHTML = state.recentTracks.map(t => renderQueueItem(t, false, false)).join('');
    container.querySelectorAll('.queue-item').forEach(item => {
      const track = state.recentTracks.find(t => t.id === item.dataset.trackId);
      if (!track) return;
      bindArtistLinks(item);
      item.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        playFromList([track], 0);
      });
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e, track);
      });
    });
  }

  // ─── Queue drag-to-reorder ───

  let _dragScrollRAF = null;
  let _dragScrollSpeed = 0;
  let _queueDragAbort = null;

  // Safety net: if dragend doesn't fire (e.g. ESC), clean up on any global dragend
  document.addEventListener('dragend', () => stopDragScroll());

  function bindQueueDragReorder() {
    // Abort previous listeners to prevent accumulation
    if (_queueDragAbort) _queueDragAbort.abort();
    _queueDragAbort = new AbortController();
    const signal = _queueDragAbort.signal;

    const container = $('#queue-up-next');
    const EDGE_ZONE = 40;
    const MAX_SPEED = 12;
    const items = container.querySelectorAll('.queue-item[draggable="true"]');

    items.forEach(item => {
      item.addEventListener('dragstart', (e) => {
        item.classList.add('dragging');
        container.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
      }, { signal });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        container.classList.remove('is-dragging');
        stopDragScroll();
        // Read new order from DOM using queue indices (handles duplicate track IDs)
        const reordered = [];
        container.querySelectorAll('.queue-item').forEach(el => {
          const qIdx = parseInt(el.dataset.queueIndex, 10);
          if (state.queue[qIdx]) reordered.push(state.queue[qIdx]);
        });
        // Rebuild queue: [tracks before and including current] + [reordered upcoming]
        const before = state.queue.slice(0, state.queueIndex + 1);
        state.queue = [...before, ...reordered];
        renderQueue();
        saveState();
      }, { signal });
    });

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const afterElement = getDragAfterElement(container, e.clientY);
      const dragging = container.querySelector('.dragging');
      if (!dragging) return;
      if (afterElement) {
        container.insertBefore(dragging, afterElement);
      } else {
        container.appendChild(dragging);
      }

      // Auto-scroll when dragging near edges
      const rect = queuePanel.getBoundingClientRect();
      const distTop = e.clientY - rect.top;
      const distBottom = rect.bottom - e.clientY;

      if (distTop < EDGE_ZONE) {
        _dragScrollSpeed = -Math.round(MAX_SPEED * (1 - distTop / EDGE_ZONE));
        startDragScroll();
      } else if (distBottom < EDGE_ZONE) {
        _dragScrollSpeed = Math.round(MAX_SPEED * (1 - distBottom / EDGE_ZONE));
        startDragScroll();
      } else {
        stopDragScroll();
      }
    }, { signal });
  }

  function startDragScroll() {
    if (_dragScrollRAF) return;
    const tick = () => {
      queuePanel.scrollTop += _dragScrollSpeed;
      _dragScrollRAF = requestAnimationFrame(tick);
    };
    _dragScrollRAF = requestAnimationFrame(tick);
  }

  function stopDragScroll() {
    if (_dragScrollRAF) {
      cancelAnimationFrame(_dragScrollRAF);
      _dragScrollRAF = null;
    }
  }

  function getDragAfterElement(container, y) {
    const elements = [...container.querySelectorAll('.queue-item:not(.dragging)')];
    return elements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  function addToRecent(track) {
    state.recentTracks = state.recentTracks.filter(t => t.id !== track.id);
    state.recentTracks.unshift(track);
    if (state.recentTracks.length > 20) state.recentTracks.pop();
    saveState();
    // Only update the lightweight parts — skip expensive API calls
    renderRecentTracks();
    renderQuickPicks();
    if (_queueActiveTab === 'history') renderHistory();
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
        card.addEventListener('click', () => openVideoPlayer(v.id, v.title, v.artist));
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showVideoContextMenu(e, v);
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

    const saveBtn = $('#btn-album-save');
    setupSaveButton(saveBtn, albumId, albumMeta?.name || 'Album', []);

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

    const albumPlayBtn = $('#btn-album-play-all');
    updatePlayAllBtn(albumPlayBtn, album.tracks, null);
    albumPlayBtn.onclick = () => {
      if (!album.tracks.length) return;
      if (isCollectionPlaying(album.tracks, null)) {
        togglePlay();
        updatePlayAllBtn(albumPlayBtn, album.tracks, null);
      } else {
        playFromList(album.tracks, 0);
        updatePlayAllBtn(albumPlayBtn, album.tracks, null);
      }
    };
    $('#btn-album-shuffle').onclick = () => {
      if (album.tracks.length) {
        const shuffled = [...album.tracks].sort(() => Math.random() - 0.5);
        playFromList(shuffled, 0);
        updatePlayAllBtn(albumPlayBtn, album.tracks, null);
      }
    };

    setupSaveButton(saveBtn, albumId, album.name || albumMeta?.name || 'Album', album.tracks);
  }

  async function showExternalPlaylistDetail(playlistId, meta) {
    switchView('album');

    const saveBtn = $('#btn-album-save');
    setupSaveButton(saveBtn, playlistId, meta?.name || 'Playlist', []);

    const heroName = $('#album-hero-name');
    const heroMeta = $('#album-hero-meta');
    const heroCover = $('#album-hero-img');
    const heroType = $('#album-hero-type');
    const tracksContainer = $('#album-tracks');

    heroName.textContent = meta?.name || 'Loading...';
    heroMeta.textContent = '';
    heroType.textContent = 'PLAYLIST';
    heroCover.src = meta?.thumbnail || '';
    tracksContainer.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;

    const tracks = await window.snowify.getPlaylistVideos(playlistId);
    if (!tracks?.length) {
      tracksContainer.innerHTML = `<div class="empty-state"><p>Could not load playlist.</p></div>`;
      return;
    }

    heroMeta.textContent = `${tracks.length} song${tracks.length !== 1 ? 's' : ''}`;

    renderTrackList(tracksContainer, tracks, 'playlist');

    const extPlayBtn = $('#btn-album-play-all');
    updatePlayAllBtn(extPlayBtn, tracks, null);
    extPlayBtn.onclick = () => {
      if (isCollectionPlaying(tracks, null)) {
        togglePlay();
        updatePlayAllBtn(extPlayBtn, tracks, null);
      } else {
        playFromList(tracks, 0);
        updatePlayAllBtn(extPlayBtn, tracks, null);
      }
    };
    $('#btn-album-shuffle').onclick = () => {
      const shuffled = [...tracks].sort(() => Math.random() - 0.5);
      playFromList(shuffled, 0);
      updatePlayAllBtn(extPlayBtn, tracks, null);
    };

    setupSaveButton(saveBtn, playlistId, meta?.name || 'Imported Playlist', tracks);
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
    const featuredSection = $('#artist-featured-section');
    const featuredContainer = $('#artist-featured');

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
    featuredSection.style.display = 'none';
    popularContainer.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
    discographyContainer.innerHTML = '';
    videosContainer.innerHTML = '';
    liveContainer.innerHTML = '';
    fansContainer.innerHTML = '';
    featuredContainer.innerHTML = '';

    const info = await window.snowify.artistInfo(artistId);

    if (!info) {
      nameEl.textContent = 'Artist not found';
      popularContainer.innerHTML = `<div class="empty-state"><p>Could not load artist info.</p></div>`;
      return;
    }

    // Fire playlist search in background (don't block rest of render)
    const searchPlaylistsPromise = window.snowify.searchPlaylists(info.name).catch(() => []);

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
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (video) showVideoContextMenu(e, video);
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
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (video) showVideoContextMenu(e, video);
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

    // Playlists section: merge Featured On + searchPlaylists, deduplicate
    const featuredOn = (info.featuredOn || []).map(p => ({ ...p, subtitle: 'Featured on' }));
    const searched = (await searchPlaylistsPromise) || [];

    const seenPl = new Set();
    const allPlaylists = [...featuredOn, ...searched].filter(p => {
      if (!p.playlistId || seenPl.has(p.playlistId)) return false;
      seenPl.add(p.playlistId);
      return true;
    });

    if (allPlaylists.length) {
      featuredSection.style.display = '';
      featuredContainer.innerHTML = allPlaylists.map(p => `
        <div class="album-card" data-playlist-id="${escapeHtml(p.playlistId)}">
          <img class="album-card-cover" src="${escapeHtml(p.thumbnail)}" alt="" loading="lazy" />
          <button class="album-card-play" title="Play">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
          </button>
          <div class="album-card-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
          <div class="album-card-meta">${escapeHtml(p.subtitle || 'Playlist')}</div>
        </div>
      `).join('');

      addScrollArrows(featuredContainer);
      featuredContainer.querySelectorAll('.album-card').forEach(card => {
        const pid = card.dataset.playlistId;
        const meta = allPlaylists.find(p => p.playlistId === pid);
        card.querySelector('.album-card-play').addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const tracks = await window.snowify.getPlaylistVideos(pid);
            if (tracks?.length) playFromList(tracks, 0);
            else showToast('Could not load playlist');
          } catch { showToast('Could not load playlist'); }
        });
        card.addEventListener('click', () => showExternalPlaylistDetail(pid, meta));
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showPlaylistContextMenu(e, pid, meta);
        });
      });
    }

    // Play all: use popular tracks
    const artistPlayBtn = $('#btn-artist-play-all');
    updatePlayAllBtn(artistPlayBtn, popular, null);
    artistPlayBtn.onclick = () => {
      if (!popular.length) return;
      if (isCollectionPlaying(popular, null)) {
        togglePlay();
        updatePlayAllBtn(artistPlayBtn, popular, null);
      } else {
        playFromList(popular, 0);
        updatePlayAllBtn(artistPlayBtn, popular, null);
      }
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
  const miniProgressFill = $('#video-mini-progress-fill');
  let _videoAudio = null; // separate audio track for split streams
  let _currentVideoId = null;
  let _isVideoMini = false;
  const VOLUME_SCALE = 0.3;

  $('#btn-close-video').addEventListener('click', closeVideoPlayer);
  $('#btn-video-minimize').addEventListener('click', minimizeVideoPlayer);
  $('#btn-video-expand').addEventListener('click', expandVideoPlayer);
  $('#btn-video-mini-close').addEventListener('click', closeVideoPlayer);
  $('#btn-video-listen').addEventListener('click', listenOnlyFromVideo);
  $('#btn-video-mini-listen').addEventListener('click', listenOnlyFromVideo);

  // ── Mini player drag to reposition ──
  let _miniDragState = null;
  let _miniWasDragged = false;

  videoOverlay.addEventListener('mousedown', (e) => {
    if (!_isVideoMini) return;
    if (!e.target.closest('.video-container')) return;
    if (e.target.closest('.video-mini-btn')) return;
    _miniWasDragged = false;
    _miniDragState = { startX: e.clientX, startY: e.clientY, moved: false };
    videoOverlay.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!_miniDragState) return;
    const dx = e.clientX - _miniDragState.startX;
    const dy = e.clientY - _miniDragState.startY;
    if (!_miniDragState.moved && Math.abs(dx) + Math.abs(dy) > 5) {
      _miniDragState.moved = true;
    }
    if (_miniDragState.moved) {
      videoOverlay.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (!_miniDragState) return;
    _miniWasDragged = _miniDragState.moved;
    if (_miniWasDragged) {
      // 1. Snapshot where the player is visually right now (with drag transform)
      const draggedRect = videoOverlay.getBoundingClientRect();

      // 2. Decide target corner
      const midX = window.innerWidth / 2;
      const midY = window.innerHeight / 2;
      const isRight = e.clientX > midX;
      const isBottom = e.clientY > midY;

      // 3. Set final CSS anchor position (with transitions disabled)
      videoOverlay.classList.add('dragging');
      videoOverlay.style.transform = '';
      videoOverlay.style.right = isRight ? '16px' : 'auto';
      videoOverlay.style.left = isRight ? 'auto' : '16px';
      videoOverlay.style.bottom = isBottom ? `calc(var(--now-playing-height) + 16px)` : 'auto';
      videoOverlay.style.top = isBottom ? 'auto' : '16px';

      // 4. Measure where the target corner actually is
      void videoOverlay.offsetHeight;
      const targetRect = videoOverlay.getBoundingClientRect();

      // 5. Offset back to dragged position via transform (visually nothing changes)
      const offsetX = draggedRect.left - targetRect.left;
      const offsetY = draggedRect.top - targetRect.top;
      videoOverlay.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
      void videoOverlay.offsetHeight;

      // 6. Enable transition and animate transform to 0 (GPU-accelerated glide to corner)
      videoOverlay.classList.remove('dragging');
      videoOverlay.style.transform = '';
    } else {
      videoOverlay.style.transform = '';
      videoOverlay.classList.remove('dragging');
    }
    _miniDragState = null;
  });

  videoOverlay.addEventListener('click', (e) => {
    if (_isVideoMini) {
      if (_miniWasDragged) { _miniWasDragged = false; return; }
      if (e.target.closest('.video-mini-btn')) return;
      if (e.target === videoPlayer || e.target.closest('.video-container')) {
        expandVideoPlayer();
      }
      return;
    }
    if (e.target === videoOverlay) minimizeVideoPlayer();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !videoOverlay.classList.contains('hidden')) {
      if (_isVideoMini) closeVideoPlayer();
      else minimizeVideoPlayer();
    }
  });

  async function openVideoPlayer(videoId, name, artist) {
    // Only save playback state if no video is currently active
    if (videoOverlay.classList.contains('hidden')) {
      _wasPlayingBeforeVideo = state.isPlaying;
    }

    // Reset mini state
    _isVideoMini = false;
    videoOverlay.classList.remove('mini');
    videoPlayer.setAttribute('controls', '');
    resetVideoOverlayPosition();

    _currentVideoId = videoId;
    videoTitle.textContent = name || 'Music Video';
    videoArtist.textContent = artist || '';
    videoPlayer.src = '';
    videoPlayer.poster = '';
    if (_videoAudio) { _videoAudio.pause(); _videoAudio = null; }
    videoLoading.classList.remove('hidden');
    videoOverlay.classList.remove('hidden');

    // Pause audio playback while watching video
    if (state.isPlaying) {
      audio.pause();
      state.isPlaying = false;
      updatePlayButton();
    }

    // Clean up previous listeners
    videoPlayer.removeEventListener('timeupdate', updateMiniProgress);
    videoPlayer.removeEventListener('seeked', syncVideoAudio);
    videoPlayer.removeEventListener('timeupdate', syncVideoAudio);
    videoPlayer.removeEventListener('pause', onVideoPause);
    videoPlayer.removeEventListener('play', onVideoPlay);

    try {
      const result = await window.snowify.getVideoStreamUrl(videoId, state.videoQuality, state.videoPremuxed);
      videoPlayer.src = result.videoUrl;
      videoLoading.classList.add('hidden');
      videoPlayer.addEventListener('timeupdate', updateMiniProgress);

      if (result.audioUrl) {
        // Split streams: sync a separate audio element
        _videoAudio = new Audio(result.audioUrl);
        _videoAudio.volume = state.volume * VOLUME_SCALE;

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

  function updateMiniProgress() {
    if (videoPlayer.duration) {
      miniProgressFill.style.width = (videoPlayer.currentTime / videoPlayer.duration * 100) + '%';
    }
  }

  function resetVideoOverlayPosition() {
    videoOverlay.style.right = '';
    videoOverlay.style.left = '';
    videoOverlay.style.top = '';
    videoOverlay.style.bottom = '';
    videoOverlay.style.transform = '';
  }

  function closeVideoPlayer() {
    videoOverlay.classList.add('hidden');
    videoOverlay.classList.remove('mini');
    videoPlayer.setAttribute('controls', '');
    _currentVideoId = null;
    _isVideoMini = false;
    _miniDragState = null;
    _miniWasDragged = false;
    videoPlayer.pause();
    videoPlayer.removeEventListener('seeked', syncVideoAudio);
    videoPlayer.removeEventListener('timeupdate', syncVideoAudio);
    videoPlayer.removeEventListener('timeupdate', updateMiniProgress);
    videoPlayer.removeEventListener('pause', onVideoPause);
    videoPlayer.removeEventListener('play', onVideoPlay);
    videoPlayer.src = '';
    miniProgressFill.style.width = '0%';
    resetVideoOverlayPosition();
    if (_videoAudio) { _videoAudio.pause(); _videoAudio.src = ''; _videoAudio = null; }

    // Resume audio if it was playing before
    if (_wasPlayingBeforeVideo && state.queue[state.queueIndex]) {
      audio.play().then(() => {
        state.isPlaying = true;
        updatePlayButton();
      }).catch(() => {});
    }
  }

  function minimizeVideoPlayer() {
    _isVideoMini = true;
    videoOverlay.classList.add('mini');
    videoPlayer.removeAttribute('controls');
  }

  function expandVideoPlayer() {
    _isVideoMini = false;
    _miniDragState = null;
    _miniWasDragged = false;
    videoOverlay.classList.remove('mini');
    videoPlayer.setAttribute('controls', '');
    resetVideoOverlayPosition();
  }

  function listenOnlyFromVideo() {
    if (!_currentVideoId) return;
    const seekTime = videoPlayer.currentTime;
    const track = makeTrackFromVideo({
      id: _currentVideoId,
      title: videoTitle.textContent,
      artist: videoArtist.textContent,
    });

    // Don't resume previous audio
    _wasPlayingBeforeVideo = false;
    closeVideoPlayer();

    // Play as audio track
    playFromList([track], 0);

    // Seek to video position after audio starts
    if (seekTime > 1) {
      const onPlaying = () => {
        audio.removeEventListener('playing', onPlaying);
        audio.currentTime = seekTime;
      };
      audio.addEventListener('playing', onPlaying);
    }
  }

  function normalizeVideo(video) {
    return {
      id: video.videoId || video.id,
      title: video.name || video.title,
      artist: video.artist || '',
      thumbnail: video.thumbnail || `https://i.ytimg.com/vi/${video.videoId || video.id}/hqdefault.jpg`,
    };
  }

  function makeTrackFromVideo(video) {
    const v = normalizeVideo(video);
    return {
      id: v.id,
      title: v.title,
      artist: v.artist,
      url: `https://music.youtube.com/watch?v=${v.id}`,
      thumbnail: v.thumbnail,
    };
  }

  // ── Video context menu ──
  function showVideoContextMenu(e, video) {
    removeContextMenu();
    const v = normalizeVideo(video);
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    const playlistSection = buildPlaylistSectionHtml();

    menu.innerHTML = `
      <div class="context-menu-item" data-action="watch-video">Play Video</div>
      <div class="context-menu-item" data-action="play-audio">Play as Audio</div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="play-next">Play Next</div>
      <div class="context-menu-item" data-action="add-queue">Add to Queue</div>
      ${playlistSection}
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-action="share">Copy Link</div>
    `;

    positionContextMenu(menu);

    const track = makeTrackFromVideo(video);

    menu.addEventListener('click', (ev) => {
      const item = ev.target.closest('[data-action]');
      if (!item) return;
      const action = item.dataset.action;
      if (action === 'none') return;
      switch (action) {
        case 'watch-video':
          openVideoPlayer(v.id, v.title, v.artist);
          break;
        case 'play-audio':
          playFromList([track], 0);
          break;
        case 'play-next':
          handlePlayNext(track);
          break;
        case 'add-queue':
          handleAddToQueue(track);
          break;
        case 'add-to-playlist':
          addToPlaylist(item.dataset.pid, track);
          break;
        case 'share':
          navigator.clipboard.writeText(`https://music.youtube.com/watch?v=${v.id}`);
          showToast('Link copied to clipboard');
          break;
      }
      removeContextMenu();
    });

    setTimeout(() => {
      document.addEventListener('click', removeContextMenu, { once: true });
    }, 10);
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
    // Restore queue display (but don't auto-play)
    const restoredTrack = state.queue[state.queueIndex];
    if (restoredTrack) {
      showNowPlaying(restoredTrack);
      document.querySelector('#app').classList.remove('no-player');
    } else {
      document.querySelector('#app').classList.add('no-player');
    }
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
        theme: isCustomTheme(state.theme) ? 'dark' : state.theme,
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
      if (cloud.theme && !isCustomTheme(cloud.theme) && !isCustomTheme(state.theme)) {
        state.theme = cloud.theme;
      }
      state.discordRpc = cloud.discordRpc ?? state.discordRpc;
      state.country = cloud.country || state.country;
      // Pause cloud save so saveState() doesn't push old data back up
      _cloudSyncPaused = true;
      saveState();
      _cloudSyncPaused = false;
      renderPlaylists();
      renderHome();
      // Apply synced theme
      if (state.theme === 'dark' || isCustomTheme(state.theme)) {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', state.theme);
      }
      loadAndApplyThemeFile(state.theme);
      // Re-apply synced settings to UI controls
      const aq = $('#setting-quality'); if (aq) aq.value = state.audioQuality;
      const vq = $('#setting-video-quality'); if (vq) vq.value = state.videoQuality;
      const at = $('#setting-autoplay'); if (at) at.checked = state.autoplay;
      const vp = $('#setting-video-premuxed'); if (vp) vp.checked = state.videoPremuxed;
      const an = $('#setting-animations'); if (an) an.checked = state.animations;
      const ef = $('#setting-effects'); if (ef) ef.checked = state.effects;
      const dr = $('#setting-discord-rpc'); if (dr) dr.checked = state.discordRpc;
      const co = $('#setting-country'); if (co) co.value = state.country || '';
      const ts = $('#theme-select'); if (ts) { await populateCustomThemes(ts, state.theme); }
      if (state.country) window.snowify.setCountry(state.country);
      document.documentElement.classList.toggle('no-animations', !state.animations);
      document.documentElement.classList.toggle('no-effects', !state.effects);
      audio.volume = state.volume * VOLUME_SCALE;
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
        theme: isCustomTheme(state.theme) ? 'dark' : state.theme,
    };
    const result = await window.snowify.cloudSave(data);
    if (result?.error) console.error('Cloud save failed:', result.error);
    else updateSyncStatus('Synced just now');
  }

  // Flush any pending cloud save before the window closes
  window.snowify.onBeforeClose(async () => {
    if (_cloudSaveTimeout) {
      clearTimeout(_cloudSaveTimeout);
      _cloudSaveTimeout = null;
      await forceCloudSave();
    }
    window.snowify.closeReady();
  });

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
      if (theme === 'dark' || isCustomTheme(theme)) {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', theme);
      }
      loadAndApplyThemeFile(theme);
    }
    applyTheme(state.theme);

    // Theme dropdown
    const themeSelect = $('#theme-select');
    await populateCustomThemes(themeSelect, state.theme);

    themeSelect.addEventListener('change', () => {
      state.theme = themeSelect.value;
      applyTheme(state.theme);
      saveState();
    });

    // Custom theme buttons
    const btnAddTheme = $('#btn-add-theme');
    const btnReloadTheme = $('#btn-reload-theme');
    const btnOpenThemes = $('#btn-open-themes');
    const btnRemoveTheme = $('#btn-remove-theme');

    if (btnAddTheme) {
      btnAddTheme.onclick = async () => {
        const added = await window.snowify.addTheme();
        if (added && added.length) {
          await populateCustomThemes(themeSelect, state.theme);
          // Auto-select the first added theme
          const newVal = 'custom:' + added[0].id;
          themeSelect.value = newVal;
          state.theme = newVal;
          applyTheme(state.theme);
          saveState();
          showToast(`Added ${added.length} theme${added.length > 1 ? 's' : ''}`);
        }
      };
    }
    if (btnReloadTheme) {
      btnReloadTheme.onclick = async () => {
        if (isCustomTheme(state.theme)) {
          const id = customThemeId(state.theme);
          // Re-copy from original source & reload fresh
          const css = await window.snowify.reloadTheme(id);
          if (css) {
            applyCustomThemeCss(css);
            showToast('Theme reloaded');
          } else {
            showToast('Theme file not found');
          }
        } else {
          // Rescan folder in case files were added externally
          await populateCustomThemes(themeSelect, state.theme);
          showToast('Theme list refreshed');
        }
      };
    }
    if (btnOpenThemes) {
      btnOpenThemes.onclick = async () => {
        await window.snowify.openThemesFolder();
      };
    }
    if (btnRemoveTheme) {
      btnRemoveTheme.onclick = async () => {
        if (!isCustomTheme(state.theme)) {
          showToast('Select a custom theme first');
          return;
        }
        const id = customThemeId(state.theme);
        if (!confirm(`Remove theme "${id}"?`)) return;
        await window.snowify.removeTheme(id);
        removeCustomThemeCss();
        state.theme = 'dark';
        themeSelect.value = 'dark';
        applyTheme(state.theme);
        saveState();
        await populateCustomThemes(themeSelect, state.theme);
        showToast('Theme removed');
      };
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

    // ─── Changelog ───
    function renderMarkdown(md) {
      // Simple markdown → HTML for release notes
      let html = escapeHtml(md);
      // Headers
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      // Bold / italic
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
      // Inline code
      html = html.replace(/`(.+?)`/g, '<code>$1</code>');
      // Horizontal rules
      html = html.replace(/^---$/gm, '<hr>');
      // Links  [text](url)
      html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      // Images  ![alt](url) → just a link (since we escaped the html)
      html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
      // Unordered lists
      html = html.replace(/^[*\-] (.+)$/gm, '<li>$1</li>');
      html = html.replace(/((?:<li>.+<\/li>\n?)+)/g, '<ul>$1</ul>');
      // Blockquotes
      html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
      // Line breaks → paragraphs
      html = html.replace(/\n{2,}/g, '</p><p>');
      html = '<p>' + html + '</p>';
      // Clean up empty paragraphs
      html = html.replace(/<p>\s*<\/p>/g, '');
      html = html.replace(/<p>\s*(<h[123]>)/g, '$1');
      html = html.replace(/(<\/h[123]>)\s*<\/p>/g, '$1');
      html = html.replace(/<p>\s*(<ul>)/g, '$1');
      html = html.replace(/(<\/ul>)\s*<\/p>/g, '$1');
      html = html.replace(/<p>\s*(<hr>)\s*<\/p>/g, '$1');
      html = html.replace(/<p>\s*(<blockquote>)/g, '$1');
      html = html.replace(/(<\/blockquote>)\s*<\/p>/g, '$1');
      return html;
    }

    async function openChangelog(version) {
      const modal = $('#changelog-modal');
      const body = $('#changelog-body');
      const meta = $('#changelog-meta');
      const title = $('#changelog-title');

      body.innerHTML = '<div class="changelog-loading"><div class="spinner"></div><p>Loading changelog...</p></div>';
      meta.textContent = '';
      title.textContent = "What's New";
      modal.classList.remove('hidden');

      const data = await window.snowify.getChangelog(version);

      if (!data || !data.body) {
        body.innerHTML = '<div class="changelog-empty"><p>No changelog available for this version.</p></div>';
        meta.textContent = `v${version}`;
        return;
      }

      title.textContent = data.name || `What's New in v${data.version}`;
      if (data.date) {
        const d = new Date(data.date);
        meta.textContent = `Released ${d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`;
      }
      body.innerHTML = renderMarkdown(data.body);

      // Make links open externally
      body.querySelectorAll('a[href]').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          window.snowify.openExternal(a.href);
        });
      });
    }

    function closeChangelog() {
      $('#changelog-modal').classList.add('hidden');
    }

    $('#changelog-close').addEventListener('click', closeChangelog);
    $('#changelog-ok').addEventListener('click', closeChangelog);
    $('#changelog-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeChangelog();
    });

    $('#btn-open-changelog').addEventListener('click', async () => {
      const version = await window.snowify.getVersion();
      openChangelog(version);
    });

    // Show changelog after update (version changed since last seen)
    (async () => {
      const version = await window.snowify.getVersion();
      const lastSeenVersion = localStorage.getItem('snowify_last_changelog_version');
      if (lastSeenVersion && lastSeenVersion !== version) {
        // Version changed — show changelog after a short delay
        setTimeout(() => openChangelog(version), 1500);
      }
      localStorage.setItem('snowify_last_changelog_version', version);
    })();

    // ─── Auto Updater UI ───
    (async () => {
      const version = await window.snowify.getVersion();
      $('#app-version-label').textContent = `v${version}`;
    })();

    const btnCheckUpdate = $('#btn-check-update');
    const btnInstallUpdate = $('#btn-install-update');
    const updateStatusRow = $('#update-status-row');
    const updateStatusLabel = $('#update-status-label');
    const updateStatusDesc = $('#update-status-desc');

    btnCheckUpdate.addEventListener('click', async () => {
      btnCheckUpdate.disabled = true;
      btnCheckUpdate.textContent = 'Checking...';
      updateStatusRow.style.display = '';
      updateStatusLabel.textContent = 'Checking for updates...';
      updateStatusDesc.textContent = '';
      btnInstallUpdate.style.display = 'none';
      await window.snowify.checkForUpdates();
      setTimeout(() => {
        btnCheckUpdate.disabled = false;
        btnCheckUpdate.textContent = 'Check for updates';
      }, 3000);
    });

    btnInstallUpdate.addEventListener('click', () => {
      btnInstallUpdate.disabled = true;
      btnInstallUpdate.textContent = 'Downloading...';
      window.snowify.installUpdate();
    });

    window.snowify.onUpdateStatus((data) => {
      updateStatusRow.style.display = '';
      switch (data.status) {
        case 'checking':
          updateStatusLabel.textContent = 'Checking for updates...';
          updateStatusDesc.textContent = '';
          btnInstallUpdate.style.display = 'none';
          break;
        case 'available':
          updateStatusLabel.textContent = `Update available: v${data.version}`;
          updateStatusDesc.textContent = 'A new version is ready to download.';
          btnInstallUpdate.style.display = '';
          btnInstallUpdate.disabled = false;
          btnInstallUpdate.textContent = 'Download & Install';
          showToast(`Update v${data.version} available`);
          break;
        case 'up-to-date':
          updateStatusLabel.textContent = 'You\u2019re up to date!';
          updateStatusDesc.textContent = '';
          btnInstallUpdate.style.display = 'none';
          break;
        case 'downloading':
          updateStatusLabel.textContent = `Downloading update... ${data.percent}%`;
          updateStatusDesc.textContent = '';
          btnInstallUpdate.style.display = 'none';
          break;
        case 'downloaded':
          updateStatusLabel.textContent = `Update v${data.version} downloaded`;
          updateStatusDesc.textContent = 'Restart now to apply the update.';
          btnInstallUpdate.style.display = '';
          btnInstallUpdate.disabled = false;
          btnInstallUpdate.textContent = 'Restart & Update';
          btnInstallUpdate.onclick = () => {
            // electron-updater quitAndInstall
            window.snowify.installUpdate();
          };
          showToast('Update downloaded — restart to apply');
          break;
        case 'error': {
          updateStatusLabel.textContent = 'Update check failed';
          // Show a clean, short message
          let errMsg = data.message || '';
          if (errMsg.includes('latest.yml') || errMsg.includes('latest-linux.yml')) {
            errMsg = 'No update metadata found in the latest release. Ensure the release was built with "npm run publish".';
          } else if (errMsg.includes('net::') || errMsg.includes('ENOTFOUND')) {
            errMsg = 'Could not reach update server. Check your internet connection.';
          } else if (errMsg.length > 120) {
            errMsg = errMsg.slice(0, 120) + '…';
          }
          updateStatusDesc.textContent = errMsg;
          btnInstallUpdate.style.display = 'none';
          break;
        }
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
        img.onerror = () => showToast('Failed to load image');
        img.onload = async () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = 128;
            canvas.height = 128;
            const ctx = canvas.getContext('2d');
            const size = Math.min(img.width, img.height);
            const sx = (img.width - size) / 2;
            const sy = (img.height - size) / 2;
            ctx.drawImage(img, sx, sy, size, size, 0, 0, 128, 128);
            // Use lower quality to stay under Firebase photoURL size limit
            const resized = canvas.toDataURL('image/jpeg', 0.5);
            const updateResult = await window.snowify.updateProfile({ photoURL: resized });
            if (updateResult?.error) {
              showToast('Failed to update avatar: ' + updateResult.error);
            } else {
              $('#profile-avatar').src = resized;
              showToast('Profile picture updated');
            }
          } catch (err) {
            showToast('Failed to update avatar');
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
