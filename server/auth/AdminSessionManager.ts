import type { Socket } from 'socket.io';

/**
 * Manages admin socket sessions
 */
class AdminSessionManager {
  private readonly adminSockets = new Set<Socket>();

  /**
   * Adds a socket as admin
   */
  addAdminSocket(socket: Socket): void {
    this.adminSockets.add(socket);

    // 연결 끊어지면 자동 제거
    socket.on('disconnect', () => {
      this.adminSockets.delete(socket);
    });
  }

  /**
   * Checks if socket is admin
   */
  isAdminSocket(socket: Socket): boolean {
    return this.adminSockets.has(socket);
  }
}

export default AdminSessionManager;
