import { requireEnv } from '../utils/env.ts';

// Note(yoochan.kim): APK distribution — the Pi's simple file server owns the
// files behind a password; this server only relays them (server/update/apkProxy.ts),
// so no client ever holds that password.
export const APK_CONFIG = {
  FILESERVER_URL: requireEnv('FILESERVER_URL'),
  FILESERVER_PASSWORD: requireEnv('FILESERVER_PASSWORD'),
  FILE_IDS: {
    phone: 'lovelight_music_player',
    tablet: 'lovelight_music_player_tablet'
  }
} as const;
