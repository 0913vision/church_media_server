/**
 * Manages admin socket sessions
 */
class AdminSessionManager {
  #adminSockets = new Set();
  
  /**
   * Adds a socket as admin
   * @param {Object} socket - Socket.IO socket instance
   */
  addAdminSocket(socket) {
    this.#adminSockets.add(socket);
    
    // 연결 끊어지면 자동 제거
    socket.on('disconnect', () => {
      this.#adminSockets.delete(socket);
    });
  }
  
  /**
   * Checks if socket is admin
   * @param {Object} socket - Socket.IO socket instance
   * @returns {boolean} True if admin, false otherwise
   */
  isAdminSocket(socket) {
    return this.#adminSockets.has(socket);
  }
}

export default AdminSessionManager;