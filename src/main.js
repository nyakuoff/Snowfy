const { app, BrowserWindow, ipcMain, session, shell, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

let mainWindow;
let ytmusic;
let _currentCountry = '';

// ─── Stream URL Cache ───
const _streamCache = new Map();
const STREAM_CACHE_TTL = 4 * 60 * 60 * 1000;

function getCachedUrl(key) {
  const entry = _streamCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > STREAM_CACHE_TTL) {
    _streamCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedUrl(key, value) {
  _streamCache.set(key, { value, ts: Date.now() });

  if (_streamCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of _streamCache) {
      if (now - v.ts > STREAM_CACHE_TTL) _streamCache.delete(k);
    }
  }
}

// ─── Discord RPC ───

const { Client } = require('@xhayper/discord-rpc');
const DISCORD_CLIENT_ID = '1473620585832517644';
let rpcClient = null;
let rpcReady = false;

async function connectDiscordRPC() {
  if (rpcClient) return;
  try {
    rpcClient = new Client({ clientId: DISCORD_CLIENT_ID });
    rpcClient.on('ready', () => { rpcReady = true; });
    rpcClient.on('disconnected', () => { rpcReady = false; rpcClient = null; });
    await rpcClient.login();
  } catch (_) {
    rpcReady = false;
    rpcClient = null;
  }
}

function disconnectDiscordRPC() {
  if (rpcClient) {
    rpcClient.destroy().catch(() => {});
    rpcClient = null;
    rpcReady = false;
  }
}

function getYtDlpPath() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
  const subDir = isWin ? 'win' : 'linux';

  // In production: resources/bin/<platform>/yt-dlp
  const bundled = path.join(process.resourcesPath, 'bin', subDir, binName);
  if (fs.existsSync(bundled)) return bundled;

  // In development: bin/<platform>/yt-dlp
  const dev = path.join(__dirname, '..', 'bin', subDir, binName);
  if (fs.existsSync(dev)) return dev;

  // Fallback to system PATH
  return binName;
}

async function initYTMusic() {
  const YTMusic = (await import('ytmusic-api')).default;
  ytmusic = new YTMusic();
  await ytmusic.initialize();
}

function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds) || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getBestThumbnail(thumbnails) {
  if (!thumbnails?.length) return '';
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || '';
}

function getSquareThumbnail(thumbnails, size = 226) {
  const url = getBestThumbnail(thumbnails);
  if (!url) return '';
  if (url.includes('lh3.googleusercontent.com')) {
    return url.replace(/=(?:w\d+-h\d+|s\d+|p-w\d+).*$/, `=w${size}-h${size}-l90-rj`);
  }
  return url;
}

function parseArtistsFromRuns(runs) {
  if (!runs?.length) return [];
  const artistRuns = runs.filter(r => {
    const pageType = r.navigationEndpoint?.browseEndpoint
      ?.browseEndpointContextSupportedConfigs
      ?.browseEndpointContextMusicConfig?.pageType;
    return pageType === 'MUSIC_PAGE_TYPE_ARTIST';
  });
  if (artistRuns.length > 0) {
    return artistRuns.map(r => ({
      name: r.text,
      id: r.navigationEndpoint.browseEndpoint.browseId
    }));
  }
  // Fallback: plain text with no browseIds
  if (runs.length >= 1 && !runs[0].navigationEndpoint) {
    const text = runs.map(r => r.text).join('');
    const dotIdx = text.indexOf(' \u2022 ');
    const artistText = dotIdx >= 0 ? text.slice(0, dotIdx) : text;
    return artistText.split(/,\s*|\s*&\s*/).filter(Boolean)
      .map(name => ({ name: name.trim(), id: null }));
  }
  return [];
}

function buildArtistFields(artists) {
  if (!artists?.length) return { artist: 'Unknown Artist', artistId: null, artists: [] };
  return {
    artist: artists.map(a => a.name).join(', '),
    artistId: artists[0].id || null,
    artists
  };
}

function mapSongToTrack(song, artists) {
  const artistFields = artists
    ? buildArtistFields(artists)
    : {
        artist: song.artist?.name || 'Unknown Artist',
        artistId: song.artist?.artistId || null,
        artists: song.artist ? [{ name: song.artist.name, id: song.artist.artistId || null }] : []
      };
  return {
    id: song.videoId,
    title: song.name || 'Unknown',
    ...artistFields,
    album: song.album?.name || null,
    albumId: song.album?.albumId || null,
    thumbnail: getSquareThumbnail(song.thumbnails),
    duration: formatDuration(song.duration),
    durationMs: song.duration ? Math.round(song.duration * 1000) : 0,
    url: `https://music.youtube.com/watch?v=${song.videoId}`
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#121212',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'logo.ico'))
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline'; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' https: data: file:; " +
          "media-src 'self' blob: https:; " +
          "connect-src 'self' https: http:;"
        ]
      }
    });
  });
}

app.whenReady().then(async () => {
  await initYTMusic();
  createWindow();
  // Restore saved session after window is ready
  autoSignIn();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── Firebase Auth & Cloud Sync ───

const firebase = require('./firebase');

let currentUser = null;

// ─── Credential Persistence via safeStorage ───
const { safeStorage } = require('electron');
const credentialsPath = path.join(app.getPath('userData'), '.auth');

function saveCredentials(email, password) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: store in plaintext (still in user's app data dir)
      fs.writeFileSync(credentialsPath, JSON.stringify({ email, password }));
      return;
    }
    const encrypted = safeStorage.encryptString(JSON.stringify({ email, password }));
    fs.writeFileSync(credentialsPath, encrypted);
  } catch (_) {}
}

function loadCredentials() {
  try {
    if (!fs.existsSync(credentialsPath)) return null;
    const raw = fs.readFileSync(credentialsPath);
    if (!safeStorage.isEncryptionAvailable()) {
      return JSON.parse(raw.toString());
    }
    return JSON.parse(safeStorage.decryptString(raw));
  } catch (_) { return null; }
}

function clearCredentials() {
  try { fs.unlinkSync(credentialsPath); } catch (_) {}
}

// Auto-sign-in from saved credentials on startup
async function autoSignIn() {
  const creds = loadCredentials();
  if (!creds) return;
  try {
    const { signInWithEmailAndPassword } = require('firebase/auth');
    await signInWithEmailAndPassword(firebase.auth, creds.email, creds.password);
  } catch (_) {
    // Credentials no longer valid, clear them
    clearCredentials();
  }
}

firebase.onAuthStateChanged(firebase.auth, (user) => {
  currentUser = user;
  mainWindow?.webContents?.send('auth:stateChanged', user ? {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL
  } : null);
});

ipcMain.handle('auth:signInWithGoogle', async () => {
  try {
    // Open a popup window for Google OAuth
    const authWindow = new BrowserWindow({
      width: 500,
      height: 700,
      show: true,
      frame: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    const clientId = require('./firebase').auth.app.options.apiKey;
    const projectId = require('./firebase').auth.app.options.projectId;
    const redirectUri = `https://${projectId}.firebaseapp.com/__/auth/handler`;
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${projectId}.firebaseapp.com&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=token&` +
      `scope=${encodeURIComponent('email profile')}`;

    // Use signInWithPopup equivalent via Firebase REST approach
    // For Electron, we use signInWithCredential after getting a Google token
    // Simplified: use email/password or custom token approach
    authWindow.close();
    return { error: 'Use email sign-in' };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('auth:signInWithEmail', async (_event, email, password) => {
  try {
    const { signInWithEmailAndPassword } = require('firebase/auth');
    const result = await signInWithEmailAndPassword(firebase.auth, email, password);
    console.log('Auth: signed in as', result.user.uid);
    saveCredentials(email, password);
    return {
      uid: result.user.uid,
      email: result.user.email,
      displayName: result.user.displayName,
      photoURL: result.user.photoURL
    };
  } catch (err) {
    console.error('Auth sign-in error:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('auth:signUpWithEmail', async (_event, email, password) => {
  try {
    const { createUserWithEmailAndPassword } = require('firebase/auth');
    const result = await createUserWithEmailAndPassword(firebase.auth, email, password);
    console.log('Auth: created account', result.user.uid);
    saveCredentials(email, password);
    return {
      uid: result.user.uid,
      email: result.user.email,
      displayName: result.user.displayName,
      photoURL: result.user.photoURL
    };
  } catch (err) {
    console.error('Auth sign-up error:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('auth:signOut', async () => {
  try {
    await firebase.signOut(firebase.auth);
    currentUser = null;
    clearCredentials();
    return true;
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('auth:getUser', () => {
  const user = firebase.auth.currentUser;
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL
  };
});

ipcMain.handle('profile:update', async (_event, { displayName, photoURL }) => {
  const user = firebase.auth.currentUser;
  if (!user) return { error: 'Not signed in' };
  try {
    const updates = {};
    if (displayName !== undefined) updates.displayName = displayName;
    if (photoURL !== undefined) updates.photoURL = photoURL;
    await firebase.updateProfile(user, updates);
    // Also save profile info to Firestore for cross-device access
    const docRef = firebase.doc(firebase.db, 'users', user.uid);
    await firebase.setDoc(docRef, {
      profile: { displayName: user.displayName, photoURL: user.photoURL }
    }, { merge: true });
    return {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL
    };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('profile:readImage', async (_event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (_) {
    return null;
  }
});

ipcMain.handle('cloud:save', async (_event, data) => {
  const user = firebase.auth.currentUser;
  if (!user) { console.log('Cloud save skipped: no user'); return { error: 'Not signed in' }; }
  try {
    console.log('Cloud save: writing to Firestore for', user.uid);
    const docRef = firebase.doc(firebase.db, 'users', user.uid);
    await firebase.setDoc(docRef, {
      ...data,
      updatedAt: Date.now()
    }, { merge: true });
    console.log('Cloud save: success');
    return true;
  } catch (err) {
    console.error('Cloud save error:', err);
    return { error: err.message };
  }
});

ipcMain.handle('cloud:load', async () => {
  const user = firebase.auth.currentUser;
  if (!user) return null;
  try {
    const docRef = firebase.doc(firebase.db, 'users', user.uid);
    const snap = await firebase.getDoc(docRef);
    if (!snap.exists()) return null;
    return snap.data();
  } catch (err) {
    console.error('Cloud load error:', err);
    return null;
  }
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    await shell.openExternal(url);
  }
});

ipcMain.handle('discord:connect', async () => {
  await connectDiscordRPC();
  return rpcReady;
});

ipcMain.handle('discord:disconnect', async () => {
  disconnectDiscordRPC();
});

ipcMain.handle('discord:updatePresence', async (_event, data) => {
  if (!rpcClient || !rpcReady) return;
  try {
    await rpcClient.user?.setActivity({
      type: 2, // "Listening to"
      details: data.title || 'Unknown',
      state: data.artist || 'Unknown Artist',
      largeImageKey: data.thumbnail || 'logo',
      smallImageKey: 'logo',
      smallImageText: 'Snowify',
      startTimestamp: data.startTimestamp ? new Date(data.startTimestamp) : undefined,
      endTimestamp: data.endTimestamp ? new Date(data.endTimestamp) : undefined,
      instance: false
    });
  } catch (_) {}
});

ipcMain.handle('discord:clearPresence', async () => {
  if (!rpcClient || !rpcReady) return;
  try {
    await rpcClient.user?.clearActivity();
  } catch (_) {}
});

ipcMain.handle('yt:search', async (_event, query, musicOnly) => {
  try {
    if (musicOnly) {
      const rawParams = 'EgWKAQIIAWoOEAMQBBAJEAoQBRAREBU%3D';
      const [songs, rawData] = await Promise.all([
        ytmusic.searchSongs(query),
        ytmusic.constructRequest('search', { query, params: rawParams }).catch(() => null)
      ]);

      const rawArtistsMap = {};
      if (rawData) {
        const shelves = rawData?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
          ?.tabRenderer?.content?.sectionListRenderer?.contents || [];
        for (const s of shelves) {
          const entries = s?.musicShelfRenderer?.contents || [];
          for (const entry of entries) {
            const r = entry?.musicResponsiveListItemRenderer;
            if (!r) continue;
            const cols = r.flexColumns || [];
            const videoId = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
              ?.navigationEndpoint?.watchEndpoint?.videoId;
            if (!videoId) continue;
            const allRuns = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
            const dotIdx = allRuns.findIndex(run => run.text === ' \u2022 ');
            const artistRuns = dotIdx >= 0 ? allRuns.slice(0, dotIdx) : allRuns;
            const artists = parseArtistsFromRuns(artistRuns);
            if (artists.length) rawArtistsMap[videoId] = artists;
          }
        }
      }

      return songs.filter(s => s.videoId).map(song => {
        const artists = rawArtistsMap[song.videoId] || null;
        return mapSongToTrack(song, artists);
      });
    } else {
      const [results, rawData] = await Promise.all([
        ytmusic.search(query),
        ytmusic.constructRequest('search', { query }).catch(() => null)
      ]);

      const rawArtistsMap = {};
      if (rawData) {
        const shelves = rawData?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
          ?.tabRenderer?.content?.sectionListRenderer?.contents || [];
        for (const s of shelves) {
          const entries = s?.musicShelfRenderer?.contents || [];
          for (const entry of entries) {
            const r = entry?.musicResponsiveListItemRenderer;
            if (!r) continue;
            const cols = r.flexColumns || [];
            const videoId = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
              ?.navigationEndpoint?.watchEndpoint?.videoId;
            if (!videoId) continue;
            const allRuns = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
            const dotIdx = allRuns.findIndex(run => run.text === ' \u2022 ');
            const artistRuns = dotIdx >= 0 ? allRuns.slice(0, dotIdx) : allRuns;
            const artists = parseArtistsFromRuns(artistRuns);
            if (artists.length) rawArtistsMap[videoId] = artists;
          }
        }
      }

      return results
        .filter(r => (r.type === 'SONG' || r.type === 'VIDEO') && r.videoId)
        .map(r => {
          const artists = rawArtistsMap[r.videoId] || null;
          const artistFields = artists
            ? buildArtistFields(artists)
            : {
                artist: r.artist?.name || 'Unknown Artist',
                artistId: r.artist?.artistId || null,
                artists: r.artist ? [{ name: r.artist.name, id: r.artist.artistId || null }] : []
              };
          return {
            id: r.videoId,
            title: r.name || 'Unknown',
            ...artistFields,
            thumbnail: getSquareThumbnail(r.thumbnails),
            duration: formatDuration(r.duration),
            durationMs: r.duration ? Math.round(r.duration * 1000) : 0,
            url: `https://music.youtube.com/watch?v=${r.videoId}`
          };
        });
    }
  } catch (err) {
    console.error('Search error:', err);
    return [];
  }
});

ipcMain.handle('yt:artistInfo', async (_event, artistId) => {
  try {
    const artist = await ytmusic.getArtist(artistId);

    // Fetch raw browse data to extract fields the library parser misses
    let monthlyListeners = '';
    let banner = '';
    let fansAlsoLike = [];
    let livePerformances = [];
    let rawTopSongsArtists = {};
    let rawTopSongsPlays = {};
    try {
      const rawData = await ytmusic.constructRequest('browse', { browseId: artistId });
      const header = rawData?.header?.musicImmersiveHeaderRenderer || rawData?.header?.musicVisualHeaderRenderer;
      monthlyListeners = header?.monthlyListenerCount?.runs?.[0]?.text || '';
      const bannerThumbs = header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      const bannerUrl = getBestThumbnail(bannerThumbs);
      if (bannerUrl && bannerUrl.includes('lh3.googleusercontent.com')) {
        banner = bannerUrl.replace(/=(?:w\d+-h\d+|s\d+|p-w\d+).*$/, '=w1440-h600-p-l90-rj');
      } else {
        banner = bannerUrl;
      }

      // Parse carousel sections by title instead of hardcoded index
      const sections = rawData?.contents?.singleColumnBrowseResultsRenderer
        ?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

      for (const section of sections) {
        const carousel = section?.musicCarouselShelfRenderer;
        if (!carousel) continue;
        const title = carousel?.header?.musicCarouselShelfBasicHeaderRenderer
          ?.title?.runs?.[0]?.text?.toLowerCase() || '';

        if (title.includes('fans might also like')) {
          fansAlsoLike = (carousel.contents || []).map(item => {
            const r = item?.musicTwoRowItemRenderer;
            if (!r) return null;
            const browseId = r?.navigationEndpoint?.browseEndpoint?.browseId || '';
            if (!browseId.startsWith('UC')) return null;
            return {
              artistId: browseId,
              name: r?.title?.runs?.[0]?.text || 'Unknown',
              thumbnail: getSquareThumbnail(r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [], 226)
            };
          }).filter(Boolean);
        } else if (title.includes('live performance')) {
          livePerformances = (carousel.contents || []).map(item => {
            const r = item?.musicTwoRowItemRenderer;
            if (!r) return null;
            const videoId = r?.navigationEndpoint?.watchEndpoint?.videoId || '';
            if (!videoId) return null;
            return {
              videoId,
              name: r?.title?.runs?.[0]?.text || 'Untitled',
              artist: artist.name || 'Unknown Artist',
              artistId: artistId,
              thumbnail: getBestThumbnail(r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || []),
              duration: ''
            };
          }).filter(Boolean);
        }
      }
      // Parse multi-artist data + plays from Songs shelf (first musicShelfRenderer, may have no title)
      for (const section of sections) {
        const shelf = section?.musicShelfRenderer;
        if (!shelf) continue;
        for (const item of (shelf.contents || [])) {
          const r = item?.musicResponsiveListItemRenderer;
          if (!r) continue;
          const cols = r.flexColumns || [];
          const videoId = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
            ?.navigationEndpoint?.watchEndpoint?.videoId;
          if (!videoId) continue;
          const artistRuns = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const artists = parseArtistsFromRuns(artistRuns);
          if (artists.length) rawTopSongsArtists[videoId] = artists;
          const playsText = cols[2]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
          if (playsText) rawTopSongsPlays[videoId] = playsText;
        }
        break;
      }
    } catch (_) { /* raw data extraction is best-effort */ }

    return {
      name: artist.name || 'Unknown',
      artistId: artist.artistId || '',
      description: '',
      followers: 0,
      monthlyListeners,
      banner,
      tags: [],
      avatar: getSquareThumbnail(artist.thumbnails, 512),
      topSongs: (artist.topSongs || []).filter(s => s.videoId).map(song => {
        const artists = rawTopSongsArtists[song.videoId] || null;
        const track = mapSongToTrack(song, artists);
        if (rawTopSongsPlays[song.videoId]) track.plays = rawTopSongsPlays[song.videoId];
        return track;
      }),
      topAlbums: (artist.topAlbums || []).map(a => ({
        albumId: a.albumId,
        playlistId: a.playlistId,
        name: a.name,
        year: a.year,
        type: 'Album',
        thumbnail: getSquareThumbnail(a.thumbnails, 300)
      })),
      topSingles: (artist.topSingles || []).map(a => ({
        albumId: a.albumId,
        playlistId: a.playlistId,
        name: a.name,
        year: a.year,
        type: 'Single',
        thumbnail: getSquareThumbnail(a.thumbnails, 300)
      })),
      topVideos: (artist.topVideos || []).map(v => ({
        videoId: v.videoId,
        name: v.name || 'Untitled Video',
        artist: v.artist?.name || 'Unknown Artist',
        artistId: v.artist?.artistId || null,
        thumbnail: getBestThumbnail(v.thumbnails),
        duration: formatDuration(v.duration)
      })),
      fansAlsoLike,
      livePerformances
    };
  } catch (err) {
    console.error('Artist info error:', err);
    return null;
  }
});

ipcMain.handle('yt:albumTracks', async (_event, albumId) => {
  try {
    const [album, rawData] = await Promise.all([
      ytmusic.getAlbum(albumId),
      ytmusic.constructRequest('browse', { browseId: albumId }).catch(() => null)
    ]);

    const rawArtistsMap = {};
    let albumArtists = [];
    if (rawData) {
      const headerRuns = rawData?.contents?.twoColumnBrowseResultsRenderer
        ?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
        ?.musicResponsiveHeaderRenderer?.straplineTextOne?.runs || [];
      albumArtists = parseArtistsFromRuns(headerRuns);

      const shelfItems = rawData?.contents?.twoColumnBrowseResultsRenderer
        ?.secondaryContents?.sectionListRenderer?.contents?.[0]
        ?.musicShelfRenderer?.contents || [];
      for (const item of shelfItems) {
        const r = item?.musicResponsiveListItemRenderer;
        if (!r) continue;
        const cols = r.flexColumns || [];
        const videoId = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
          ?.navigationEndpoint?.watchEndpoint?.videoId;
        if (!videoId) continue;
        const artistRuns = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const artists = parseArtistsFromRuns(artistRuns);
        if (artists.length) rawArtistsMap[videoId] = artists;
      }
    }

    const tracks = (album.songs || []).filter(s => s.videoId).map(song => {
      const artists = rawArtistsMap[song.videoId] || (albumArtists.length ? albumArtists : null);
      return mapSongToTrack(song, artists);
    });

    const albumArtistFields = albumArtists.length
      ? buildArtistFields(albumArtists)
      : buildArtistFields(album.artist?.id
          ? [{ name: album.artist.name, id: album.artist.id }]
          : []);

    return {
      name: album.name || 'Unknown Album',
      ...albumArtistFields,
      year: album.year || null,
      thumbnail: getSquareThumbnail(album.thumbnails, 300),
      tracks
    };
  } catch (err) {
    console.error('Album tracks error:', err);
    return null;
  }
});

ipcMain.handle('yt:searchArtists', async (_event, query) => {
  try {
    // Use raw API to get subscriber/listener info alongside artist data
    const rawData = await ytmusic.constructRequest('search', {
      query,
      params: 'Eg-KAQwIABAAGAAgASgAMABqChAEEAMQCRAFEAo%3D'
    });

    const items = [];
    const shelf = rawData?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const s of shelf) {
      const entries = s?.musicShelfRenderer?.contents || [];
      for (const entry of entries) {
        const r = entry?.musicResponsiveListItemRenderer;
        if (!r) continue;
        const cols = r.flexColumns || [];
        const runs = cols.flatMap(c =>
          c?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
        );
        const browseId = r.navigationEndpoint?.browseEndpoint?.browseId || '';
        const name = runs[0]?.text || '';
        const subtitle = runs.slice(1).map(r => r.text).join('').replace(/^\s*•\s*/, '').trim();
        const thumbnails = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
        if (browseId && name) {
          items.push({
            artistId: browseId,
            name,
            thumbnail: getBestThumbnail(thumbnails),
            subtitle: subtitle.replace(/^Artist\s*•?\s*/i, '').trim()
          });
        }
      }
    }
    return items;
  } catch (err) {
    console.error('Search artists error:', err);
    return [];
  }
});

// ─── Explore (New Releases, Trending, Charts) ───

ipcMain.handle('yt:setCountry', async (_event, countryCode) => {
  try {
    if (!ytmusic?.config) return false;
    const code = countryCode || '';
    if (code) {
      ytmusic.config.GL = code;
      ytmusic.config.INNERTUBE_CONTEXT_GL = code;
      if (ytmusic.config.INNERTUBE_CONTEXT?.client) {
        ytmusic.config.INNERTUBE_CONTEXT.client.gl = code;
      }
    }
    ytmusic.config.HL = 'en';
    ytmusic.config.INNERTUBE_CONTEXT_HL = 'en';
    if (ytmusic.config.INNERTUBE_CONTEXT?.client) {
      ytmusic.config.INNERTUBE_CONTEXT.client.hl = 'en';
    }
    _currentCountry = code;
    return true;
  } catch (err) {
    console.error('Set country error:', err);
    return false;
  }
});

ipcMain.handle('yt:explore', async () => {
  try {
    const rawData = await ytmusic.constructRequest('browse', { browseId: 'FEmusic_explore' });
    const sections = rawData?.contents?.singleColumnBrowseResultsRenderer
      ?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    const result = { newAlbums: [], moods: [], newMusicVideos: [] };

    for (const section of sections) {
      const carousel = section?.musicCarouselShelfRenderer;
      if (!carousel) continue;
      const title = (carousel?.header?.musicCarouselShelfBasicHeaderRenderer
        ?.title?.runs?.[0]?.text || '').toLowerCase();

      if (title.includes('new albums') || title.includes('new release')) {
        result.newAlbums = (carousel.contents || []).map(item => {
          const r = item?.musicTwoRowItemRenderer;
          if (!r) return null;
          const albumId = r?.navigationEndpoint?.browseEndpoint?.browseId || '';
          if (!albumId) return null;
          const subtitleRuns = r?.subtitle?.runs || [];
          const artists = parseArtistsFromRuns(subtitleRuns);
          const artistFields = artists.length ? buildArtistFields(artists) : { artist: subtitleRuns.map(s => s.text).join(''), artistId: null };
          return {
            albumId,
            name: r?.title?.runs?.[0]?.text || 'Unknown',
            ...artistFields,
            thumbnail: getSquareThumbnail(r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [], 300),
            year: null,
            type: 'Album'
          };
        }).filter(Boolean);
      } else if (title.includes('music video')) {
        result.newMusicVideos = (carousel.contents || []).map(item => {
          const r = item?.musicTwoRowItemRenderer;
          if (!r) return null;
          const videoId = r?.navigationEndpoint?.watchEndpoint?.videoId || '';
          if (!videoId) return null;
          const subtitleRuns = r?.subtitle?.runs || [];
          const artists = parseArtistsFromRuns(subtitleRuns);
          const artistFields = artists.length ? buildArtistFields(artists) : { artist: subtitleRuns.map(s => s.text).join(''), artistId: null };
          return {
            id: videoId,
            title: r?.title?.runs?.[0]?.text || 'Unknown',
            ...artistFields,
            thumbnail: getBestThumbnail(r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || []),
            duration: '',
            durationMs: 0,
            url: `https://music.youtube.com/watch?v=${videoId}`
          };
        }).filter(Boolean);
      } else if (title.includes('mood') || title.includes('genre')) {
        result.moods = (carousel.contents || []).map(item => {
          const r = item?.musicNavigationButtonRenderer || item?.musicTwoRowItemRenderer;
          if (!r) return null;
          const browseId = r?.clickCommand?.browseEndpoint?.browseId
            || r?.navigationEndpoint?.browseEndpoint?.browseId || '';
          const params = r?.clickCommand?.browseEndpoint?.params
            || r?.navigationEndpoint?.browseEndpoint?.params || '';
          const label = r?.buttonText?.runs?.[0]?.text || r?.title?.runs?.[0]?.text || '';
          const color = r?.solid?.leftStripeColor;
          if (!browseId || !label) return null;
          return { browseId, params, label, color: color ? `#${(color >>> 0).toString(16).padStart(8, '0').slice(0, 6)}` : null };
        }).filter(Boolean);
      }
    }

    return result;
  } catch (err) {
    console.error('Explore error:', err);
    return null;
  }
});

ipcMain.handle('yt:charts', async () => {
  try {
    const rawData = await ytmusic.constructRequest('browse', { browseId: 'FEmusic_charts' });
    let sections = rawData?.contents?.singleColumnBrowseResultsRenderer
      ?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    if (!sections.length) {
      sections = rawData?.contents?.sectionListRenderer?.contents || [];
    }

    const result = { topSongs: [], topVideos: [], topArtists: [] };

    // Extract chart playlist IDs from the "Video charts" carousel
    let trendingPlaylistId = null;
    for (const section of sections) {
      const carousel = section?.musicCarouselShelfRenderer;
      if (!carousel) continue;
      const title = (carousel?.header?.musicCarouselShelfBasicHeaderRenderer
        ?.title?.runs?.[0]?.text || '').toLowerCase();

      if (title.includes('video chart') || title.includes('trending')) {
        for (const item of (carousel.contents || [])) {
          const r = item?.musicTwoRowItemRenderer;
          if (!r) continue;
          const itemTitle = (r?.title?.runs || []).map(run => run.text).join('').toLowerCase();
          const browseId = r?.navigationEndpoint?.browseEndpoint?.browseId || '';
          if (itemTitle.includes('trending') && browseId) {
            trendingPlaylistId = browseId;
            break;
          }
        }
      } else if (title.includes('top artist') || title.includes('trending artist')) {
        result.topArtists = (carousel.contents || []).slice(0, 20).map(item => {
          const r = item?.musicResponsiveListItemRenderer || item?.musicTwoRowItemRenderer;
          if (!r) return null;
          const artistId = r?.navigationEndpoint?.browseEndpoint?.browseId || '';
          if (!artistId || !artistId.startsWith('UC')) return null;
          const name = r?.title?.runs?.[0]?.text
            || r?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text
            || 'Unknown';
          return {
            artistId,
            name,
            thumbnail: getSquareThumbnail(r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails
              || r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [], 226)
          };
        }).filter(Boolean);
      }
    }

    // Fetch top songs from the Trending chart playlist
    if (trendingPlaylistId) {
      try {
        const plRaw = await ytmusic.constructRequest('browse', { browseId: trendingPlaylistId });
        const plShelf = plRaw?.contents?.twoColumnBrowseResultsRenderer
          ?.secondaryContents?.sectionListRenderer?.contents?.[0]?.musicPlaylistShelfRenderer;
        result.topSongs = (plShelf?.contents || []).map(item => {
          const r = item?.musicResponsiveListItemRenderer;
          if (!r) return null;
          const cols = r.flexColumns || [];
          const videoId = r?.overlay?.musicItemThumbnailOverlayRenderer?.content
            ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
            || cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
              ?.navigationEndpoint?.watchEndpoint?.videoId;
          if (!videoId) return null;
          const trackName = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || 'Unknown';
          const artistRuns = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const artists = parseArtistsFromRuns(artistRuns);
          const artistFields = artists.length ? buildArtistFields(artists) : { artist: artistRuns.map(s => s.text).join(''), artistId: null };
          const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
          const rank = r?.customIndexColumn?.musicCustomIndexColumnRenderer?.text?.runs?.[0]?.text || '';
          return {
            id: videoId,
            title: trackName,
            ...artistFields,
            thumbnail: getSquareThumbnail(thumbs),
            rank: parseInt(rank, 10) || 0,
            duration: r?.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '',
            url: `https://music.youtube.com/watch?v=${videoId}`
          };
        }).filter(Boolean);
      } catch (plErr) {
        console.error('Chart playlist fetch error:', plErr);
      }
    }

    return result;
  } catch (err) {
    console.error('Charts error:', err);
    return null;
  }
});

ipcMain.handle('yt:browseMood', async (_event, browseId, params) => {
  try {
    const rawData = await ytmusic.constructRequest('browse', { browseId, params });
    const grid = rawData?.contents?.singleColumnBrowseResultsRenderer
      ?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    const playlists = [];
    for (const section of grid) {
      const items = section?.gridRenderer?.items || section?.musicCarouselShelfRenderer?.contents || [];
      for (const item of items) {
        const r = item?.musicTwoRowItemRenderer;
        if (!r) continue;
        const playlistId = r?.navigationEndpoint?.browseEndpoint?.browseId || '';
        if (!playlistId) continue;
        playlists.push({
          playlistId,
          name: r?.title?.runs?.[0]?.text || 'Unknown',
          subtitle: (r?.subtitle?.runs || []).map(s => s.text).join(''),
          thumbnail: getSquareThumbnail(r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [], 300)
        });
      }
    }
    return playlists;
  } catch (err) {
    console.error('Browse mood error:', err);
    return [];
  }
});

ipcMain.handle('yt:getStreamUrl', async (_event, videoUrl, quality) => {
  const fmt = quality === 'worstaudio' ? 'worstaudio' : 'bestaudio';
  const cacheKey = `audio:${videoUrl}:${fmt}`;
  const cached = getCachedUrl(cacheKey);
  if (cached) return cached;

  return new Promise((resolve, reject) => {
    execFile(getYtDlpPath(), [
      '-f', fmt,
      '--get-url',
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificates',
      videoUrl
    ], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr?.trim() || err.message);
      const url = stdout.trim().split('\n')[0];
      if (!url) return reject('yt-dlp returned no URL');
      setCachedUrl(cacheKey, url);
      resolve(url);
    });
  });
});

ipcMain.handle('yt:getVideoStreamUrl', async (_event, videoId, quality, premuxed) => {
  const height = parseInt(quality) || 720;
  const fmt = premuxed
    ? `best[height<=${height}]/best`
    : `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}]/best`;
  const cacheKey = `video:${videoId}:${fmt}`;
  const cached = getCachedUrl(cacheKey);
  if (cached) return cached;

  return new Promise((resolve, reject) => {
    execFile(getYtDlpPath(), [
      '-f', fmt,
      '--get-url',
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificates',
      `https://music.youtube.com/watch?v=${videoId}`
    ], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr?.trim() || err.message);
      const urls = stdout.trim().split('\n').filter(Boolean);
      if (!urls.length) return reject('yt-dlp returned no video URL');
      const result = { videoUrl: urls[0], audioUrl: urls[1] || null };
      setCachedUrl(cacheKey, result);
      resolve(result);
    });
  });
});

ipcMain.handle('yt:getUpNexts', async (_event, videoId) => {
  try {
    const rawData = await ytmusic.constructRequest('next', {
      videoId,
      playlistId: `RDAMVM${videoId}`,
      isAudioOnly: true
    });

    const contents = rawData?.contents?.singleColumnMusicWatchNextResultsRenderer
      ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.musicQueueRenderer?.content
      ?.playlistPanelRenderer?.contents || [];

    return contents.slice(1)
      .map(item => {
        const r = item?.playlistPanelVideoRenderer;
        if (!r) return null;
        const vid = r.navigationEndpoint?.watchEndpoint?.videoId;
        if (!vid) return null;

        const allRuns = r.longBylineText?.runs || [];
        const dotIdx = allRuns.findIndex(run => run.text === ' \u2022 ');
        const artistRuns = dotIdx >= 0 ? allRuns.slice(0, dotIdx) : allRuns;
        const artists = parseArtistsFromRuns(artistRuns);

        const durationText = r.lengthText?.runs?.[0]?.text || '';
        const durationParts = durationText.split(':').map(Number);
        let durationMs = 0;
        if (durationParts.length === 2) durationMs = (durationParts[0] * 60 + durationParts[1]) * 1000;
        else if (durationParts.length === 3) durationMs = (durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2]) * 1000;

        const thumbnail = getSquareThumbnail(r.thumbnail?.thumbnails || []);

        return {
          id: vid,
          title: r.title?.runs?.[0]?.text || 'Unknown',
          ...buildArtistFields(artists),
          thumbnail,
          duration: durationText,
          durationMs,
          url: `https://music.youtube.com/watch?v=${vid}`
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error('getUpNexts error:', err);
    return [];
  }
});

// ─── Lyrics (Musixmatch + LrcLib + Netease via SyncLyrics) ───

const { SyncLyrics } = require('@stef-0012/synclyrics');

let _mxmTokenData = null;

// LRU-limited cache for lyrics (max 50 entries)
const _lyricsCache = new Map();
const _lyricsCacheLimit = 50;
const lyricsCacheProxy = {
  get(key) { return _lyricsCache.get(key); },
  set(key, value) {
    if (_lyricsCache.size >= _lyricsCacheLimit) {
      const oldest = _lyricsCache.keys().next().value;
      _lyricsCache.delete(oldest);
    }
    _lyricsCache.set(key, value);
  },
  has(key) { return _lyricsCache.has(key); },
  delete(key) { return _lyricsCache.delete(key); },
  clear() { _lyricsCache.clear(); },
  get size() { return _lyricsCache.size; }
};

const lyricsManager = new SyncLyrics({
  cache: lyricsCacheProxy,
  logLevel: 'none',
  sources: ['musixmatch', 'lrclib', 'netease'],
  saveMusixmatchToken: (tokenData) => { _mxmTokenData = tokenData; },
  getMusixmatchToken: () => _mxmTokenData,
});

ipcMain.handle('lyrics:get', async (_event, trackName, artistName, albumName, durationSec) => {
  try {
    const data = await lyricsManager.getLyrics({
      track: trackName || '',
      artist: artistName || '',
      album: albumName || '',
      length: durationSec ? Math.round(durationSec * 1000) : undefined,
    });

    if (!data) return null;

    const synced = data.lyrics?.lineSynced?.lyrics || null;
    const plain = data.lyrics?.plain?.lyrics || null;
    const source = data.lyrics?.lineSynced?.source || data.lyrics?.plain?.source || 'Unknown';

    if (!synced && !plain) return null;

    return { synced, plain, source };
  } catch (err) {
    console.error('Lyrics fetch error:', err.message);
    return null;
  }
});

// ─── Spotify Playlist Import (CSV) ───

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

ipcMain.handle('spotify:pickCsv', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Spotify CSV export files',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled || !result.filePaths.length) return null;

  const playlists = [];
  for (const filePath of result.filePaths) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lines = raw.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) continue;

      const headers = parseCsvLine(lines[0]).map(h => h.trim());
      const titleIdx = headers.findIndex(h => /^(track.?name|title|song.?name|name)$/i.test(h));
      const artistIdx = headers.findIndex(h => /^(artist.?name|artists?\(?s?\)?|artist)$/i.test(h));
      if (titleIdx === -1) continue;

      const tracks = [];
      for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        const title = fields[titleIdx]?.trim();
        if (!title) continue;
        const artist = artistIdx !== -1
          ? (fields[artistIdx]?.replace(/\\,/g, ', ').trim() || 'Unknown Artist')
          : 'Unknown Artist';
        tracks.push({ title, artist });
      }

      const name = path.basename(filePath, '.csv').replace(/_/g, ' ');
      playlists.push({ name, tracks });
    } catch (err) {
      console.error(`Error parsing CSV ${filePath}:`, err.message);
    }
  }

  return playlists.length ? playlists : null;
});

ipcMain.handle('spotify:matchTrack', async (_event, title, artist) => {
  try {
    const query = `${title} ${artist}`;
    const songs = await ytmusic.searchSongs(query);
    const match = songs.find(s => s.videoId);
    if (!match) return null;
    return mapSongToTrack(match);
  } catch (err) {
    console.error('Spotify match error:', err);
    return null;
  }
});

// ─── Playlist Cover Image Management ───

function getCoversDir() {
  const dir = path.join(app.getPath('userData'), 'playlist-covers');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('playlist:pickImage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose playlist cover image',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('playlist:saveImage', async (_event, playlistId, sourcePath) => {
  try {
    const coversDir = getCoversDir();
    const ext = path.extname(sourcePath) || '.jpg';
    const destName = `${playlistId}_${Date.now()}${ext}`;
    const destPath = path.join(coversDir, destName);
    fs.copyFileSync(sourcePath, destPath);
    return destPath;
  } catch (err) {
    console.error('Save cover image error:', err);
    return null;
  }
});

ipcMain.handle('playlist:deleteImage', async (_event, imagePath) => {
  try {
    if (imagePath && fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }
    return true;
  } catch (err) {
    console.error('Delete cover image error:', err);
    return false;
  }
});
