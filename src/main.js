const { app, BrowserWindow, ipcMain, session, shell, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

let mainWindow;
let ytmusic;

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
  mainWindow = new BrowserWindow({
    width: 1300,
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
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

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
    return {
      name: artist.name || 'Unknown',
      artistId: artist.artistId || '',
      description: '',
      followers: 0,
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
      similarArtists: (artist.similarArtists || []).map(sa => ({
        artistId: sa.artistId,
        name: sa.name,
        thumbnail: getBestThumbnail(sa.thumbnails)
      }))
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
    const artists = await ytmusic.searchArtists(query);
    return artists.map(a => ({
      artistId: a.artistId,
      name: a.name,
      thumbnail: getBestThumbnail(a.thumbnails)
    }));
  } catch (err) {
    console.error('Search artists error:', err);
    return [];
  }
});

ipcMain.handle('yt:getStreamUrl', async (_event, videoUrl, quality) => {
  const fmt = quality === 'worstaudio' ? 'worstaudio' : 'bestaudio';
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

// ─── Lyrics (LRCLIB) ───

const _lyricsCache = new Map();

ipcMain.handle('lyrics:get', async (_event, trackName, artistName, albumName, durationSec) => {
  const cacheKey = `${trackName}||${artistName}`.toLowerCase();
  if (_lyricsCache.has(cacheKey)) return _lyricsCache.get(cacheKey);

  try {
    // 1. Fast search first (instant, no external lookups)
    const results = await fetchLrclib(`/api/search?${new URLSearchParams({
      track_name: trackName,
      artist_name: artistName
    })}`);
    if (Array.isArray(results) && results.length) {
      const withSync = results.find(r => r.syncedLyrics);
      const best = withSync || results[0];
      const out = { synced: best.syncedLyrics || null, plain: best.plainLyrics || null };
      _lyricsCache.set(cacheKey, out);
      return out;
    }

    // 2. Slow fallback: /api/get tries external sources (only if search found nothing)
    if (albumName && durationSec) {
      const exact = await fetchLrclib(`/api/get?${new URLSearchParams({
        track_name: trackName,
        artist_name: artistName,
        album_name: albumName,
        duration: String(Math.round(durationSec))
      })}`);
      if (exact && (exact.syncedLyrics || exact.plainLyrics)) {
        const out = { synced: exact.syncedLyrics || null, plain: exact.plainLyrics || null };
        _lyricsCache.set(cacheKey, out);
        return out;
      }
    }

    _lyricsCache.set(cacheKey, null);
    return null;
  } catch (err) {
    console.error('Lyrics fetch error:', err);
    return null;
  }
});

function fetchLrclib(path) {
  const url = `https://lrclib.net${path}`;
  return fetch(url, {
    headers: { 'User-Agent': 'Snowfy v1.0.0 (https://github.com/snowfy)' }
  }).then(res => {
    if (res.status === 404) return null;
    return res.json();
  });
}

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
