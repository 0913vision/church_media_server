import type { ServerSocket } from '../constants/socketConfig.ts';

class AdminSessionManager {
  private readonly adminSockets = new Set<ServerSocket>();

  addAdminSocket(socket: ServerSocket): void {
    // Note(yoochan.kim): re-authenticating an already-admin socket must not stack another disconnect listener.
    if (this.adminSockets.has(socket)) {
      return;
    }
    this.adminSockets.add(socket);

    socket.on('disconnect', () => {
      this.adminSockets.delete(socket);
    });
  }

  isAdminSocket(socket: ServerSocket): boolean {
    return this.adminSockets.has(socket);
  }
}

export default AdminSessionManager;
