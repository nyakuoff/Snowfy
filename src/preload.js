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
  getStreamUrl: (videoUrl, quality) => ipcRenderer.invoke('yt:getStreamUrl', videoUrl, quality),
  artistInfo: (artistId) => ipcRenderer.invoke('yt:artistInfo', artistId),
  albumTracks: (albumId) => ipcRenderer.invoke('yt:albumTracks', albumId),
  getUpNexts: (videoId) => ipcRenderer.invoke('yt:getUpNexts', videoId),
  getVideoStreamUrl: (videoId, quality, premuxed) => ipcRenderer.invoke('yt:getVideoStreamUrl', videoId, quality, premuxed),
  getLyrics: (trackName, artistName, albumName, duration) => ipcRenderer.invoke('lyrics:get', trackName, artistName, albumName, duration),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Playlist covers
  pickImage: () => ipcRenderer.invoke('playlist:pickImage'),
  saveImage: (playlistId, sourcePath) => ipcRenderer.invoke('playlist:saveImage', playlistId, sourcePath),
  deleteImage: (imagePath) => ipcRenderer.invoke('playlist:deleteImage', imagePath),

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

  // Discord RPC
  connectDiscord: () => ipcRenderer.invoke('discord:connect'),
  disconnectDiscord: () => ipcRenderer.invoke('discord:disconnect'),
  updatePresence: (data) => ipcRenderer.invoke('discord:updatePresence', data),
  clearPresence: () => ipcRenderer.invoke('discord:clearPresence'),
});
