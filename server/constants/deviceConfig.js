// Device hardware configuration
export const DEVICE_CONFIG = {
  // MPV library paths for different platforms
  MPV_LIBRARY_PATH: {
    MAC: '/opt/homebrew/lib/libmpv.dylib',
    RASPBERRY_PI: '/lib/arm-linux-gnueabihf/libmpv.so'
  },
  
  // Current platform
  CURRENT_PLATFORM: process.platform === 'darwin' ? 'MAC' : 'RASPBERRY_PI',
  
  // Audio file playlist
  PLAYLIST: [
    './assets/audio/music_slow.mp3',
    './assets/audio/music_fast.mp3'
  ],
  
  // Initial song times
  INITIAL_SONG_TIMES: {
    slow: 0.0,
    fast: 0.0
  },

  // Console configuration
  CONSOLE_MODE: process.env.CONSOLE_MODE || 'X32', // 'X32' or 'MOCK'
  
  // MPV operation settings
  MAX_PROPERTY_SET_ATTEMPTS: 10,
  PROPERTY_SET_RETRY_DELAY_MS: 50
};