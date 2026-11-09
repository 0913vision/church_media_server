import dgram from 'node:dgram';

const NTP_EPOCH_OFFSET_SEC = 2_208_988_800;

export interface NtpReply {
  readonly leap: number;
  readonly version: number;
  readonly mode: number;
  readonly stratum: number;
  readonly poll: number;
  /** The request's own transmit field, as the reply carried it back. */
  readonly origin: Buffer;
  readonly receiveMs: number;
  readonly transmitMs: number;
}

function readTimestamp(packet: Buffer, at: number): number {
  return (packet.readUInt32BE(at) - NTP_EPOCH_OFFSET_SEC) * 1000 + (packet.readUInt32BE(at + 4) / 2 ** 32) * 1000;
}

/** Asks an NTP server once, as a client would; null when nothing answers in time. */
export function askNtp(port: number, options: { version?: number; mode?: number; bytes?: number } = {}): Promise<NtpReply | null> {
  const { version = 4, mode = 3, bytes = 48 } = options;
  const request = Buffer.alloc(bytes);
  request[0] = (version << 3) | mode;
  if (bytes >= 48) {
    request[2] = 6;
    // Note(yoochan.kim): any eight bytes will do; a server must hand them back unchanged.
    request.write('ORIGIN!!', 40, 'ascii');
  }
  const socket = dgram.createSocket('udp4');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, 400);
    socket.on('message', (reply) => {
      clearTimeout(timer);
      socket.close();
      resolve({
        leap: reply[0]! >> 6,
        version: (reply[0]! >> 3) & 0b111,
        mode: reply[0]! & 0b111,
        stratum: reply[1]!,
        poll: reply[2]!,
        origin: reply.subarray(24, 32),
        receiveMs: readTimestamp(reply, 32),
        transmitMs: readTimestamp(reply, 40),
      });
    });
    socket.send(request, port, '127.0.0.1');
  });
}
