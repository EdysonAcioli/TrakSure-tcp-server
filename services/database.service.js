const { Client } = require("pg");

/**
 * Serviço para comunicação com banco PostgreSQL + PostGIS
 * Gerencia operações de dispositivos, localizações e comandos
 */
class DatabaseService {
  constructor() {
    this.client = null;
    this.connectionString =
      process.env.DATABASE_URL ||
      "postgresql://traksure:traksure_pass@localhost:5432/traksure";
  }

  /**
   * Conectar ao banco de dados
   */
  async connect() {
    try {
      this.client = new Client({
        connectionString: this.connectionString,
      });

      await this.client.connect();
      console.log("Database connected successfully");
    } catch (error) {
      console.error("Failed to connect to database:", error);
      throw error;
    }
  }

  /**
   * Executar query SQL
   */
  async query(sql, params = []) {
    try {
      if (!this.client) {
        await this.connect();
      }

      const result = await this.client.query(sql, params);
      return result;
    } catch (error) {
      console.error("Database query error:", error);
      throw error;
    }
  }

  /**
   * Obter dispositivo pelo IMEI
   */
  async getDeviceByImei(imei) {
    const sql = `
      SELECT id, imei, company_id, active, created_at
      FROM devices 
      WHERE imei = $1 AND active = true
    `;

    const result = await this.query(sql, [imei]);
    return result.rows[0] || null;
  }

  /**
   * Obter ID do dispositivo pelo IMEI
   */
  async getDeviceIdByImei(imei) {
    const device = await this.getDeviceByImei(imei);
    return device ? device.id : null;
  }

  /**
   * Salvar localização do dispositivo
   */
  async saveLocation(locationData) {
    const sql = `
      INSERT INTO locations (
        device_id, latitude, longitude, speed, course, altitude,
        recorded_at, geom, satellites, hdop, battery_level, 
        signal_strength, raw_data
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        ST_SetSRID(ST_MakePoint($3, $2), 4326),
        $8, $9, $10, $11, $12
      )
      RETURNING id, recorded_at
    `;

    const params = [
      locationData.device_id,
      locationData.latitude,
      locationData.longitude,
      locationData.speed || 0,
      locationData.course || 0,
      locationData.altitude || 0,
      locationData.timestamp || new Date(),
      locationData.satellites || 0,
      locationData.hdop || 0,
      locationData.battery_level,
      locationData.signal_strength,
      locationData.raw_data ? JSON.stringify(locationData.raw_data) : null,
    ];

    const result = await this.query(sql, params);
    return result.rows[0];
  }

  /**
   * Salvar alerta/alarme
   */
  async saveAlert(alertData) {
    const sql = `
      INSERT INTO alerts (
        device_id, alert_type, message, latitude, longitude,
        triggered_at, geom, raw_data, resolved
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        ST_SetSRID(ST_MakePoint($5, $4), 4326),
        $7, false
      )
      RETURNING id, triggered_at
    `;

    const params = [
      alertData.device_id,
      alertData.alert_type,
      alertData.message,
      alertData.latitude,
      alertData.longitude,
      alertData.timestamp || new Date(),
      alertData.raw_data ? JSON.stringify(alertData.raw_data) : null,
    ];

    const result = await this.query(sql, params);
    return result.rows[0];
  }

  /**
   * Criar comando para dispositivo
   */
  async createCommand(commandData) {
    const sql = `
      INSERT INTO commands (
        device_id, command_type, payload, status, created_at
      ) VALUES (
        $1, $2, $3, 'pending', NOW()
      )
      RETURNING id, created_at
    `;

    const params = [
      commandData.device_id,
      commandData.command_type,
      JSON.stringify(commandData.payload || {}),
    ];

    const result = await this.query(sql, params);
    return result.rows[0];
  }

  /**
   * Atualizar status de comando
   */
  async updateCommandStatus(commandId, status, data = {}) {
    const updateFields = ["status = $2"];
    const params = [commandId, status];
    let paramIndex = 3;

    if (data.response) {
      updateFields.push(`response = $${paramIndex}`);
      params.push(JSON.stringify(data.response));
      paramIndex++;
    }

    if (data.error) {
      updateFields.push(`error_message = $${paramIndex}`);
      params.push(data.error);
      paramIndex++;
    }

    if (status === "sent" || data.sent_at) {
      updateFields.push(`sent_at = $${paramIndex}`);
      params.push(data.sent_at || new Date());
      paramIndex++;
    }

    if (status === "acknowledged" || data.ack_at) {
      updateFields.push(`ack_at = $${paramIndex}`);
      params.push(data.ack_at || new Date());
      paramIndex++;
    }

    if (status === "failed" || data.failed_at) {
      updateFields.push(`failed_at = $${paramIndex}`);
      params.push(data.failed_at || new Date());
      paramIndex++;
    }

    const sql = `
      UPDATE commands 
      SET ${updateFields.join(", ")}, updated_at = NOW()
      WHERE id = $1
      RETURNING id, status, updated_at
    `;

    const result = await this.query(sql, params);
    return result.rows[0];
  }

  /**
   * Obter comando por ID
   */
  async getCommandById(commandId) {
    const sql = `
      SELECT c.*, d.imei 
      FROM commands c
      JOIN devices d ON c.device_id = d.id
      WHERE c.id = $1
    `;

    const result = await this.query(sql, [commandId]);
    return result.rows[0] || null;
  }

  /**
   * Obter comandos pendentes para um dispositivo
   */
  async getPendingCommands(deviceId) {
    const sql = `
      SELECT * FROM commands
      WHERE device_id = $1 AND status = 'pending'
      ORDER BY created_at ASC
    `;

    const result = await this.query(sql, [deviceId]);
    return result.rows;
  }

  /**
   * Atualizar status online do dispositivo
   */
  async setDeviceOnlineStatus(imei, isOnline) {
    const sql = `
      UPDATE devices 
      SET 
        online = $2,
        last_seen = CASE WHEN $2 THEN NOW() ELSE last_seen END,
        updated_at = NOW()
      WHERE imei = $1
      RETURNING id, online, last_seen
    `;

    const result = await this.query(sql, [imei, isOnline]);
    return result.rows[0];
  }

  /**
   * Atualizar último heartbeat
   */
  async updateLastHeartbeat(imei) {
    const sql = `
      UPDATE devices 
      SET last_heartbeat = NOW(), updated_at = NOW()
      WHERE imei = $1
      RETURNING id, last_heartbeat
    `;

    const result = await this.query(sql, [imei]);
    return result.rows[0];
  }

  /**
   * Atualizar último login
   */
  async updateLastLogin(imei) {
    const sql = `
      UPDATE devices 
      SET last_login = NOW(), updated_at = NOW()
      WHERE imei = $1
      RETURNING id, last_login
    `;

    const result = await this.query(sql, [imei]);
    return result.rows[0];
  }

  /**
   * Obter última localização de um dispositivo
   */
  async getLastLocation(deviceId) {
    const sql = `
      SELECT l.*, ST_X(l.geom) as longitude, ST_Y(l.geom) as latitude
      FROM locations l
      WHERE device_id = $1
      ORDER BY recorded_at DESC
      LIMIT 1
    `;

    const result = await this.query(sql, [deviceId]);
    return result.rows[0] || null;
  }

  /**
   * Obter histórico de localizações
   */
  async getLocationHistory(deviceId, startDate, endDate, limit = 1000) {
    const sql = `
      SELECT 
        l.*,
        ST_X(l.geom) as longitude, 
        ST_Y(l.geom) as latitude
      FROM locations l
      WHERE device_id = $1
        AND recorded_at >= $2
        AND recorded_at <= $3
      ORDER BY recorded_at DESC
      LIMIT $4
    `;

    const result = await this.query(sql, [deviceId, startDate, endDate, limit]);
    return result.rows;
  }

  /**
   * Obter dispositivos próximos a uma coordenada
   */
  async getNearbyDevices(latitude, longitude, radiusKm = 10) {
    const sql = `
      SELECT 
        d.id, d.imei,
        l.latitude, l.longitude, l.recorded_at,
        ST_Distance(
          l.geom,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
        ) / 1000 as distance_km
      FROM devices d
      JOIN LATERAL (
        SELECT * FROM locations
        WHERE device_id = d.id
        ORDER BY recorded_at DESC
        LIMIT 1
      ) l ON true
      WHERE ST_DWithin(
        l.geom,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
        $3 * 1000
      )
      ORDER BY distance_km ASC
    `;

    const result = await this.query(sql, [latitude, longitude, radiusKm]);
    return result.rows;
  }

  /**
   * Obter estatísticas do sistema
   */
  async getSystemStats() {
    const stats = {};

    // Total de dispositivos
    const devicesResult = await this.query(
      "SELECT COUNT(*) as total FROM devices WHERE active = true"
    );
    stats.totalDevices = parseInt(devicesResult.rows[0].total);

    // Dispositivos online
    const onlineResult = await this.query(
      "SELECT COUNT(*) as total FROM devices WHERE online = true"
    );
    stats.onlineDevices = parseInt(onlineResult.rows[0].total);

    // Total de localizações hoje
    const locationsResult = await this.query(`
      SELECT COUNT(*) as total 
      FROM locations 
      WHERE recorded_at >= CURRENT_DATE
    `);
    stats.locationsToday = parseInt(locationsResult.rows[0].total);

    // Alertas não resolvidos
    const alertsResult = await this.query(
      "SELECT COUNT(*) as total FROM alerts WHERE resolved = false"
    );
    stats.unresolvedAlerts = parseInt(alertsResult.rows[0].total);

    return stats;
  }

  /**
   * Fechar conexão
   */
  async close() {
    if (this.client) {
      await this.client.end();
      this.client = null;
      console.log("Database connection closed");
    }
  }

  /**
   * Verificar se está conectado
   */
  isConnected() {
    return this.client && this.client._connected;
  }
}

module.exports = { DatabaseService };
