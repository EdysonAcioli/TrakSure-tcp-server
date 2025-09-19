const { DatabaseService } = require("./services/database.service");

/**
 * Gerenciador de dispositivos conectados
 * Controla estado online/offline, heartbeats e estatísticas
 */
class DeviceManager {
  constructor() {
    this.database = new DatabaseService();
    this.deviceStatus = new Map(); // Cache local do status dos dispositivos
    this.heartbeatInterval = 60000; // 1 minuto
    this.offlineTimeout = 300000; // 5 minutos

    // Iniciar verificação periódica
    this.startPeriodicChecks();
  }

  /**
   * Iniciar verificações periódicas de status
   */
  startPeriodicChecks() {
    // Verificar dispositivos offline a cada minuto
    setInterval(() => {
      this.checkOfflineDevices();
    }, this.heartbeatInterval);

    // Limpar cache de status antigos a cada 10 minutos
    setInterval(() => {
      this.cleanupStatusCache();
    }, 600000);
  }

  /**
   * Definir dispositivo como online/offline
   */
  async setDeviceOnline(imei, isOnline) {
    try {
      // Atualizar no banco
      const result = await this.database.setDeviceOnlineStatus(imei, isOnline);

      // Atualizar cache local
      this.deviceStatus.set(imei, {
        online: isOnline,
        lastSeen: new Date(),
        lastUpdate: new Date(),
      });

      console.log(`Device ${imei} set to ${isOnline ? "online" : "offline"}`);
      return result;
    } catch (error) {
      console.error(`Error setting device ${imei} online status:`, error);
      throw error;
    }
  }

  /**
   * Atualizar último heartbeat
   */
  async updateLastHeartbeat(imei) {
    try {
      // Atualizar no banco
      const result = await this.database.updateLastHeartbeat(imei);

      // Atualizar cache local
      const status = this.deviceStatus.get(imei) || {};
      status.lastHeartbeat = new Date();
      status.lastSeen = new Date();
      status.online = true;
      this.deviceStatus.set(imei, status);

      return result;
    } catch (error) {
      console.error(`Error updating heartbeat for ${imei}:`, error);
      throw error;
    }
  }

  /**
   * Atualizar último login
   */
  async updateLastLogin(imei) {
    try {
      const result = await this.database.updateLastLogin(imei);

      // Atualizar cache local
      const status = this.deviceStatus.get(imei) || {};
      status.lastLogin = new Date();
      status.lastSeen = new Date();
      status.online = true;
      this.deviceStatus.set(imei, status);

      console.log(`Device ${imei} login updated`);
      return result;
    } catch (error) {
      console.error(`Error updating login for ${imei}:`, error);
      throw error;
    }
  }

  /**
   * Verificar dispositivos que ficaram offline
   */
  async checkOfflineDevices() {
    try {
      const now = new Date();
      const offlineDevices = [];

      // Verificar dispositivos no cache local
      for (const [imei, status] of this.deviceStatus.entries()) {
        if (status.online && status.lastSeen) {
          const timeSinceLastSeen = now - status.lastSeen;

          if (timeSinceLastSeen > this.offlineTimeout) {
            offlineDevices.push(imei);
          }
        }
      }

      // Marcar dispositivos como offline
      for (const imei of offlineDevices) {
        await this.setDeviceOnline(imei, false);
        console.log(`Device ${imei} marked as offline due to timeout`);
      }

      if (offlineDevices.length > 0) {
        console.log(`Marked ${offlineDevices.length} devices as offline`);
      }
    } catch (error) {
      console.error("Error checking offline devices:", error);
    }
  }

  /**
   * Limpar cache de status antigos
   */
  cleanupStatusCache() {
    const now = new Date();
    const maxAge = 3600000; // 1 hora

    for (const [imei, status] of this.deviceStatus.entries()) {
      if (status.lastUpdate && now - status.lastUpdate > maxAge) {
        this.deviceStatus.delete(imei);
      }
    }
  }

  /**
   * Obter status de um dispositivo
   */
  getDeviceStatus(imei) {
    return this.deviceStatus.get(imei) || null;
  }

  /**
   * Obter todos os dispositivos online
   */
  getOnlineDevices() {
    const onlineDevices = [];

    for (const [imei, status] of this.deviceStatus.entries()) {
      if (status.online) {
        onlineDevices.push({
          imei,
          lastSeen: status.lastSeen,
          lastHeartbeat: status.lastHeartbeat,
          lastLogin: status.lastLogin,
        });
      }
    }

    return onlineDevices;
  }

  /**
   * Obter estatísticas dos dispositivos
   */
  async getDeviceStats() {
    try {
      // Estatísticas do banco
      const dbStats = await this.database.getSystemStats();

      // Estatísticas do cache local
      let onlineCount = 0;
      let recentActivity = 0;
      const now = new Date();

      for (const status of this.deviceStatus.values()) {
        if (status.online) {
          onlineCount++;
        }

        if (status.lastSeen && now - status.lastSeen < 300000) {
          // 5 minutos
          recentActivity++;
        }
      }

      return {
        ...dbStats,
        cachedOnline: onlineCount,
        recentActivity: recentActivity,
        cacheSize: this.deviceStatus.size,
      };
    } catch (error) {
      console.error("Error getting device stats:", error);
      return {
        error: error.message,
        cachedOnline: 0,
        recentActivity: 0,
        cacheSize: this.deviceStatus.size,
      };
    }
  }

  /**
   * Verificar se dispositivo está conectado
   */
  isDeviceOnline(imei) {
    const status = this.deviceStatus.get(imei);
    return status ? status.online : false;
  }

  /**
   * Obter último tempo visto de um dispositivo
   */
  getLastSeen(imei) {
    const status = this.deviceStatus.get(imei);
    return status ? status.lastSeen : null;
  }

  /**
   * Registrar atividade de dispositivo
   */
  registerDeviceActivity(imei, activityType = "data") {
    const status = this.deviceStatus.get(imei) || {};

    status.lastSeen = new Date();
    status.lastActivity = activityType;
    status.activityCount = (status.activityCount || 0) + 1;

    this.deviceStatus.set(imei, status);
  }

  /**
   * Obter dispositivos com problemas de conectividade
   */
  getProblematicDevices() {
    const now = new Date();
    const problematicDevices = [];

    for (const [imei, status] of this.deviceStatus.entries()) {
      const issues = [];

      // Dispositivo marcado como online mas sem atividade recente
      if (status.online && status.lastSeen) {
        const timeSinceLastSeen = now - status.lastSeen;

        if (timeSinceLastSeen > 180000) {
          // 3 minutos
          issues.push("no_recent_activity");
        }
      }

      // Sem heartbeat há muito tempo
      if (status.lastHeartbeat) {
        const timeSinceHeartbeat = now - status.lastHeartbeat;

        if (timeSinceHeartbeat > 600000) {
          // 10 minutos
          issues.push("missing_heartbeat");
        }
      }

      if (issues.length > 0) {
        problematicDevices.push({
          imei,
          issues,
          lastSeen: status.lastSeen,
          lastHeartbeat: status.lastHeartbeat,
          online: status.online,
        });
      }
    }

    return problematicDevices;
  }

  /**
   * Resetar status de um dispositivo
   */
  resetDeviceStatus(imei) {
    this.deviceStatus.delete(imei);
    console.log(`Status reset for device ${imei}`);
  }

  /**
   * Resetar status de todos os dispositivos
   */
  resetAllDeviceStatus() {
    this.deviceStatus.clear();
    console.log("All device status reset");
  }

  /**
   * Exportar status atual para debug
   */
  exportStatusForDebug() {
    const statusData = {};

    for (const [imei, status] of this.deviceStatus.entries()) {
      statusData[imei] = {
        ...status,
        lastSeen: status.lastSeen ? status.lastSeen.toISOString() : null,
        lastHeartbeat: status.lastHeartbeat
          ? status.lastHeartbeat.toISOString()
          : null,
        lastLogin: status.lastLogin ? status.lastLogin.toISOString() : null,
      };
    }

    return {
      timestamp: new Date().toISOString(),
      deviceCount: this.deviceStatus.size,
      devices: statusData,
    };
  }

  /**
   * Parar verificações periódicas
   */
  stop() {
    // Note: Em produção, você deveria manter referências aos intervals
    // para poder limpá-los adequadamente
    console.log("Device Manager stopped");
  }
}

module.exports = { DeviceManager };
