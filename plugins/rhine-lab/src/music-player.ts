import { MusicPlayer as BrowserMusicPlayer } from './music-browser-player';
import { TwilightMusicPlayer } from './host/player';
import { isHosted } from './host/bridge';
export type { MusicPlayerState, AudioCapabilities, AudioOutputDevice } from './music-browser-player';
export const MusicPlayer = isHosted ? TwilightMusicPlayer : BrowserMusicPlayer;
