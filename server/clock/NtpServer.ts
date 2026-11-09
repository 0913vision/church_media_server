import dgram from 'node:dgram';
import type Clock from './Clock.ts';
import { errorMessage } from '../utils/errors.ts';
import { log } from '../utils/logger.ts';

/** Seconds from NTP's epoch (1900) to the Unix one (1970). */
const NTP_EPOCH_OFFSET_SEC = 2_208_988_800;
const PACKET_BYTES = 48;
const MODE_CLIENT = 3;
const MODE_SERVER = 4;
// Note(yoochan.kim): the Pi sets its own clock from internet time servers, so it answers a level below them.
const STRATUM = 3;
// Note(yoochan.kim): Date counts milliseconds, about 2^-10 s.
const PRECISION = -10;
// Note(yoochan.kim): 10ms in NTP's 16.16 seconds, the most a millisecond clock on Wi-Fi can claim.
const ROOT_DISPERSION = Math.round(0.01 * 2 ** 16);
const REFERENCE_ID = 'CHRC';

/** NTP (RFC 5905) for devices that set their own clock: the answer is church time, not standard time. */
class NtpServer {
  private readonly socket = dgram.createSocket('udp4');
  /** The port it answers on, once bound. */
  readonly listening: Promise<number>;

  constructor(private readonly clock: Clock, port: number) {
    this.socket.on('message', (request, from) => this.answer(request, from));
    // Note(yoochan.kim): a port it cannot have stops the time, not the music.
    this.socket.on('error', (error) => {
      log.error('ntp', null, 'Church time is not served', { port, error: errorMessage(error) });
    });
    this.listening = new Promise((resolve) => {
      this.socket.bind(port, () => {
        const bound = this.socket.address().port;
        log.info('ntp', null, 'Serving church time over NTP', { port: bound });
        resolve(bound);
      });
    });
  }

  dispose(): void {
    this.socket.close();
  }

  private answer(request: Buffer, from: dgram.RemoteInfo): void {
    const receivedAt = this.clock.now();
    // Note(yoochan.kim): only a client's question is answered; control and broadcast packets get nothing.
    if (request.length < PACKET_BYTES || (request[0]! & 0b111) !== MODE_CLIENT) return;

    const asked = (request[0]! >> 3) & 0b111;
    const version = asked >= 1 && asked <= 4 ? asked : 4;
    const reply = Buffer.alloc(PACKET_BYTES);
    reply[0] = (version << 3) | MODE_SERVER;
    reply[1] = STRATUM;
    reply[2] = request[2]!;
    reply.writeInt8(PRECISION, 3);
    reply.writeUInt32BE(ROOT_DISPERSION, 8);
    reply.write(REFERENCE_ID, 12, 'ascii');
    writeTimestamp(reply, 16, receivedAt);
    // Note(yoochan.kim): the client's own transmit time comes back as the origin, which is how it pairs the answer.
    request.copy(reply, 24, 40, 48);
    writeTimestamp(reply, 32, receivedAt);
    writeTimestamp(reply, 40, this.clock.now());
    this.socket.send(reply, from.port, from.address);
  }
}

function writeTimestamp(packet: Buffer, at: number, time: Date): void {
  const ms = time.getTime();
  packet.writeUInt32BE((Math.floor(ms / 1000) + NTP_EPOCH_OFFSET_SEC) % 2 ** 32, at);
  packet.writeUInt32BE(Math.floor(((ms % 1000) / 1000) * 2 ** 32), at + 4);
}

export default NtpServer;
