import type { ServerSocket } from '../constants/socketConfig.ts';

/**
 * Manages admin socket sessions
 */
class AdminSessionManager {
  private readonly adminSockets = new Set<ServerSocket>();

  /**
   * Adds a socket as admin
   */
  addAdminSocket(socket: ServerSocket): void {
    // Note(yoochan.kim): Re-authenticating an already-admin socket must not stack another
    // disconnect listener.
    if (this.adminSockets.has(socket)) {
      return;
    }
    this.adminSockets.add(socket);

    // Note(yoochan.kim): 연결 끊어지면 자동 제거
    socket.on('disconnect', () => {
      this.adminSockets.delete(socket);
    });
  }

  /**
   * Checks if socket is admin
   */
  isAdminSocket(socket: ServerSocket): boolean {
    return this.adminSockets.has(socket);
  }
}

export default AdminSessionManager;
