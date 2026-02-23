const { app, BrowserWindow, ipcMain, session, shell, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

let mainWindow;
let ytmusic;

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
  const isMac = process.platform === 'darwin';
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';

  // macOS: check common install locations (Electron from Finder has limited PATH)
  if (isMac) {
    const macPaths = [
      '/opt/homebrew/bin/yt-dlp',           // brew (Apple Silicon)
      '/usr/local/bin/yt-dlp',              // brew (Intel) or pip3 system
      path.join(os.homedir(), '.local/bin/yt-dlp'), // pip3 --user (Linux-style)
    ];
    // Dynamically discover pip3 --user versioned paths: ~/Library/Python/X.Y/bin/yt-dlp
    try {
      const pyLibDir = path.join(os.homedir(), 'Library', 'Python');
      if (fs.existsSync(pyLibDir)) {
        const versions = fs.readdirSync(pyLibDir)
          .filter(d => /^\d+\.\d+$/.test(d))
          .sort((a, b) => parseFloat(b) - parseFloat(a)); // newest first
        for (const v of versions) {
          macPaths.push(path.join(pyLibDir, v, 'bin', 'yt-dlp'));
        }
      }
    } catch (_) {}
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p;
    }
    return binName; // fallback to PATH
  }

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
    return url.replace(/=w\d+-h\d+.*$/, `=w${size}-h${size}-l90-rj`);
  }
  return url;
}

function mapSongToTrack(song) {
  return {
    id: song.videoId,
    title: song.name || 'Unknown',
    artist: song.artist?.name || 'Unknown Artist',
    artistId: song.artist?.artistId || null,
    album: song.album?.name || null,
    thumbnail: getSquareThumbnail(song.thumbnails),
    duration: formatDuration(song.duration),
    durationMs: song.duration ? Math.round(song.duration * 1000) : 0,
    url: `https://music.youtube.com/watch?v=${song.videoId}`
  };
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#121212',
    titleBarStyle: 'hidden',
    ...(isMac && { trafficLightPosition: { x: 16, y: 12 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'logo.ico'))
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Inject platform class before first paint (avoids visual flash)
  if (process.platform === 'darwin') {
    mainWindow.webContents.on('dom-ready', () => {
      mainWindow.webContents.executeJavaScript(
        "document.documentElement.classList.add('platform-darwin');"
      );
    });
  }

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

// ─── macOS yt-dlp Setup Check ───

function checkMacYtDlp() {
  if (process.platform !== 'darwin') return;

  const { execFileSync, execSync } = require('child_process');

  // Check if yt-dlp is already installed (use getYtDlpPath which checks all known locations)
  const ytdlp = getYtDlpPath();
  try {
    execFileSync(ytdlp, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return; // yt-dlp works
  } catch (_) {
    // not found or broken — try auto-install
  }

  // Helper: verify yt-dlp actually works after install
  function verifyYtDlp() {
    const p = getYtDlpPath();
    try {
      execFileSync(p, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  // Try auto-install with brew
  const hasBrew = (() => { try { execFileSync('which', ['brew'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();
  if (hasBrew) {
    const response = dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      title: 'First Time Setup',
      message: 'Installing yt-dlp...',
      detail: 'yt-dlp is required for audio streaming. Homebrew was detected on your system.\n\nClick "Install" to install it automatically.',
      buttons: ['Install', 'Cancel'],
      defaultId: 0,
      noLink: true
    });
    if (response === 0) {
      try {
        execSync('brew install yt-dlp', { timeout: 120000, stdio: 'pipe' });
      } catch (_) {}
      if (verifyYtDlp()) {
        dialog.showMessageBoxSync(mainWindow, {
          type: 'info',
          title: 'Setup Complete',
          message: 'yt-dlp installed successfully!',
          detail: 'Snowify is ready to use.',
          buttons: ['OK']
        });
        return;
      }
      dialog.showMessageBoxSync(mainWindow, {
        type: 'error',
        title: 'Installation Failed',
        message: 'Could not install yt-dlp via Homebrew.',
        detail: 'Please try manually in Terminal:\n\nbrew install yt-dlp',
        buttons: ['OK']
      });
    }
    return; // brew exists — don't fall through to pip (user can retry)
  }

  // No brew — show manual instructions to install Homebrew first
  const response = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    title: 'yt-dlp Not Found',
    message: 'Setup Required',
    detail: 'yt-dlp is required for audio streaming but could not be installed automatically.\n\nInstall Homebrew from https://brew.sh, then run:\n\nbrew install yt-dlp',
    buttons: ['Open brew.sh', 'OK'],
    defaultId: 1,
    noLink: true
  });

  if (response === 0) {
    shell.openExternal('https://brew.sh');
  }
}

app.whenReady().then(async () => {
  await initYTMusic();
  createWindow();
  checkMacYtDlp();
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
      const songs = await ytmusic.searchSongs(query);
      return songs.filter(s => s.videoId).map(mapSongToTrack);
    } else {
      const results = await ytmusic.search(query);
      return results
        .filter(r => (r.type === 'SONG' || r.type === 'VIDEO') && r.videoId)
        .map(r => ({
          id: r.videoId,
          title: r.name || 'Unknown',
          artist: r.artist?.name || 'Unknown Artist',
          artistId: r.artist?.artistId || null,
          thumbnail: getSquareThumbnail(r.thumbnails),
          duration: formatDuration(r.duration),
          durationMs: r.duration ? Math.round(r.duration * 1000) : 0,
          url: `https://music.youtube.com/watch?v=${r.videoId}`
        }));
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
    let fansAlsoLike = [];
    let livePerformances = [];
    try {
      const rawData = await ytmusic.constructRequest('browse', { browseId: artistId });
      const header = rawData?.header?.musicImmersiveHeaderRenderer || rawData?.header?.musicVisualHeaderRenderer;
      monthlyListeners = header?.monthlyListenerCount?.runs?.[0]?.text || '';

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
    } catch (_) { /* raw data extraction is best-effort */ }

    return {
      name: artist.name || 'Unknown',
      artistId: artist.artistId || '',
      description: '',
      followers: 0,
      monthlyListeners,
      tags: [],
      avatar: getBestThumbnail(artist.thumbnails),
      topSongs: (artist.topSongs || []).filter(s => s.videoId).map(mapSongToTrack),
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
    const album = await ytmusic.getAlbum(albumId);
    return {
      name: album.name || 'Unknown Album',
      artist: album.artist?.name || 'Unknown Artist',
      year: album.year || null,
      thumbnail: getSquareThumbnail(album.thumbnails, 300),
      tracks: (album.songs || []).filter(s => s.videoId).map(mapSongToTrack)
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

ipcMain.handle('yt:getStreamUrl', async (_event, videoUrl, quality) => {
  const fmt = quality === 'worstaudio' ? 'worstaudio/worstaudio*/worst' : 'bestaudio/bestaudio*/best';
  return new Promise((resolve, reject) => {
    execFile(getYtDlpPath(), [
      '-f', fmt,
      '--get-url',
      '--no-warnings',
      '--no-playlist',
      videoUrl
    ], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr?.trim() || err.message);
      const url = stdout.trim().split('\n')[0];
      if (!url) return reject('yt-dlp returned no URL');
      resolve(url);
    });
  });
});

ipcMain.handle('yt:getVideoStreamUrl', async (_event, videoId, quality, premuxed) => {
  const height = parseInt(quality) || 720;
  const fmt = premuxed
    ? `best[height<=${height}]/best`
    : `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}]/best`;
  return new Promise((resolve, reject) => {
    execFile(getYtDlpPath(), [
      '-f', fmt,
      '--get-url',
      '--no-warnings',
      '--no-playlist',
      `https://music.youtube.com/watch?v=${videoId}`
    ], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr?.trim() || err.message);
      const urls = stdout.trim().split('\n').filter(Boolean);
      if (!urls.length) return reject('yt-dlp returned no video URL');
      // If 2 URLs: [video, audio]. If 1 URL: muxed stream
      resolve({ videoUrl: urls[0], audioUrl: urls[1] || null });
    });
  });
});

ipcMain.handle('yt:getUpNexts', async (_event, videoId) => {
  try {
    const results = await ytmusic.getUpNexts(videoId);
    if (!Array.isArray(results)) return [];
    return results
      .filter(r => r.videoId)
      .map(r => ({
        id: r.videoId,
        title: r.title || r.name || 'Unknown',
        artist: r.artists || r.artist?.name || 'Unknown Artist',
        artistId: r.artist?.artistId || null,
        thumbnail: r.thumbnail || getSquareThumbnail(r.thumbnails || []),
        duration: r.duration || '',
        durationMs: 0,
        url: `https://music.youtube.com/watch?v=${r.videoId}`
      }));
  } catch (err) {
    console.error('getUpNexts error:', err);
    return [];
  }
});

// ─── Lyrics (Musixmatch + LrcLib + Netease via SyncLyrics) ───

const { SyncLyrics } = require('@stef-0012/synclyrics');

let _mxmTokenData = null;

const lyricsManager = new SyncLyrics({
  cache: new Map(),
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
