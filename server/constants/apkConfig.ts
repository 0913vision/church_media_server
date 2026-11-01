import { requireEnv } from '../utils/env.ts';

// Note(yoochan.kim): the Pi's file server keeps the APKs behind a password; relayed here so no client holds it.
export const APK_CONFIG = {
  FILESERVER_URL: requireEnv('FILESERVER_URL'),
  FILESERVER_PASSWORD: requireEnv('FILESERVER_PASSWORD'),
  FILE_IDS: {
    phone: 'lovelight_music_player',
    tablet: 'lovelight_music_player_tablet'
  }
} as const;
