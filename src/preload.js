const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snowfy', {
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
  getLyrics: (trackName, artistName, albumName, duration) => ipcRenderer.invoke('lyrics:get', trackName, artistName, albumName, duration),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Playlist covers
  pickImage: () => ipcRenderer.invoke('playlist:pickImage'),
  saveImage: (playlistId, sourcePath) => ipcRenderer.invoke('playlist:saveImage', playlistId, sourcePath),
  deleteImage: (imagePath) => ipcRenderer.invoke('playlist:deleteImage', imagePath),
});
