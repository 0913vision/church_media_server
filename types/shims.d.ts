// Minimal local type declarations for dependencies that ship no types.
// Only the surface this project actually uses is declared.

declare module 'osc' {
  export interface UdpPortOptions {
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
  }

  export class UDPPort {
    constructor(options: UdpPortOptions);
    open(): void;
    on(event: string, callback: () => void): void;
    send(message: { address: string; args: unknown }): void;
  }

  const osc: { UDPPort: typeof UDPPort };
  export default osc;
}

declare module 'ffi-napi' {
  // A foreign function definition: [return type, argument types]
  type ForeignFunctionDef = [unknown, unknown[]];

  const ffi: {
    // Returns an object whose methods mirror the definition map; callers cast
    // it to their own typed interface.
    Library(path: string, definitions: Record<string, ForeignFunctionDef>): unknown;
  };
  export default ffi;
}

declare module 'ref-array-napi' {
  // Returns an FFI array-type descriptor used in Library definitions
  function array(type: string): unknown;
  export default array;
}
