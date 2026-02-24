const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snowify', {
  // Platform
  platform: process.platform,

  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // YouTube Music
  search: (query, musicOnly) => ipcRenderer.invoke('yt:search', query, musicOnly),
  searchArtists: (query) => ipcRenderer.invoke('yt:searchArtists', query),
  searchAlbums: (query) => ipcRenderer.invoke('yt:searchAlbums', query),
  searchVideos: (query) => ipcRenderer.invoke('yt:searchVideos', query),
  searchPlaylists: (query) => ipcRenderer.invoke('yt:searchPlaylists', query),
  getPlaylistVideos: (playlistId) => ipcRenderer.invoke('yt:getPlaylistVideos', playlistId),
  searchSuggestions: (query) => ipcRenderer.invoke('yt:searchSuggestions', query),
  getStreamUrl: (videoUrl, quality) => ipcRenderer.invoke('yt:getStreamUrl', videoUrl, quality),
  artistInfo: (artistId) => ipcRenderer.invoke('yt:artistInfo', artistId),
  albumTracks: (albumId) => ipcRenderer.invoke('yt:albumTracks', albumId),
  getUpNexts: (videoId) => ipcRenderer.invoke('yt:getUpNexts', videoId),
  getVideoStreamUrl: (videoId, quality, premuxed) => ipcRenderer.invoke('yt:getVideoStreamUrl', videoId, quality, premuxed),
  explore: () => ipcRenderer.invoke('yt:explore'),
  charts: () => ipcRenderer.invoke('yt:charts'),
  browseMood: (browseId, params) => ipcRenderer.invoke('yt:browseMood', browseId, params),
  setCountry: (code) => ipcRenderer.invoke('yt:setCountry', code),
  getLyrics: (trackName, artistName, albumName, duration) => ipcRenderer.invoke('lyrics:get', trackName, artistName, albumName, duration),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Custom themes
  scanThemes: () => ipcRenderer.invoke('theme:scan'),
  loadTheme: (id) => ipcRenderer.invoke('theme:load', id),
  reloadTheme: (id) => ipcRenderer.invoke('theme:reload', id),
  addTheme: () => ipcRenderer.invoke('theme:add'),
  removeTheme: (id) => ipcRenderer.invoke('theme:remove', id),
  openThemesFolder: () => ipcRenderer.invoke('theme:openFolder'),

  // Playlist covers
  pickImage: () => ipcRenderer.invoke('playlist:pickImage'),
  saveImage: (playlistId, sourcePath) => ipcRenderer.invoke('playlist:saveImage', playlistId, sourcePath),
  deleteImage: (imagePath) => ipcRenderer.invoke('playlist:deleteImage', imagePath),

  // Playlist export
  exportPlaylistCsv: (name, tracks) => ipcRenderer.invoke('playlist:exportCsv', name, tracks),

  // Account & Cloud Sync
  signInWithEmail: (email, password) => ipcRenderer.invoke('auth:signInWithEmail', email, password),
  signUpWithEmail: (email, password) => ipcRenderer.invoke('auth:signUpWithEmail', email, password),
  authSignOut: () => ipcRenderer.invoke('auth:signOut'),
  getUser: () => ipcRenderer.invoke('auth:getUser'),
  updateProfile: (data) => ipcRenderer.invoke('profile:update', data),
  readImage: (filePath) => ipcRenderer.invoke('profile:readImage', filePath),
  cloudSave: (data) => ipcRenderer.invoke('cloud:save', data),
  cloudLoad: () => ipcRenderer.invoke('cloud:load'),
  onAuthStateChanged: (callback) => {
    ipcRenderer.on('auth:stateChanged', (_event, user) => callback(user));
  },

  // Spotify import (CSV)
  spotifyPickCsv: () => ipcRenderer.invoke('spotify:pickCsv'),
  spotifyMatchTrack: (title, artist) => ipcRenderer.invoke('spotify:matchTrack', title, artist),

  // Windows thumbbar
  updateThumbar: (isPlaying) => ipcRenderer.send('thumbar:updateState', isPlaying),
  onThumbarPrev: (cb) => ipcRenderer.on('thumbar:prev', cb),
  onThumbarPlayPause: (cb) => ipcRenderer.on('thumbar:playPause', cb),
  onThumbarNext: (cb) => ipcRenderer.on('thumbar:next', cb),

  // Discord RPC
  connectDiscord: () => ipcRenderer.invoke('discord:connect'),
  disconnectDiscord: () => ipcRenderer.invoke('discord:disconnect'),
  updatePresence: (data) => ipcRenderer.invoke('discord:updatePresence', data),
  clearPresence: () => ipcRenderer.invoke('discord:clearPresence'),

  // Auto-updater
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.send('updater:install'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('updater:status', (_event, data) => callback(data));
  },
});
