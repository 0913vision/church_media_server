// Note(yoochan.kim): only the surface this project uses is declared.

declare module 'osc' {
  export interface UdpPortOptions {
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
    /** Arguments travel as { type, value } both ways, so an int stays an int */
    metadata: true;
  }

  export interface OscArgument {
    type: string;
    value: unknown;
  }

  export interface OscMessage {
    address: string;
    args: OscArgument[];
  }

  export class UDPPort {
    constructor(options: UdpPortOptions);
    open(): void;
    on(event: 'ready', callback: () => void): void;
    on(event: 'message', callback: (message: OscMessage) => void): void;
    on(event: 'error', callback: (error: Error) => void): void;
    send(message: { address: string; args?: OscArgument[] }): void;
  }

  const osc: { UDPPort: typeof UDPPort };
  export default osc;
}

declare module 'ffi-napi' {
  // Note(yoochan.kim): [return type, argument types].
  type ForeignFunctionDef = [unknown, unknown[]];

  const ffi: {
    // Note(yoochan.kim): callers cast the result to their own interface, one method per definition.
    Library(path: string, definitions: Record<string, ForeignFunctionDef>): unknown;
  };
  export default ffi;
}

declare module 'ref-array-napi' {
  // Note(yoochan.kim): an FFI array-type descriptor for Library definitions.
  function array(type: string): unknown;
  export default array;
}
