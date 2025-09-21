const net = require("net");
const EventEmitter = require("events");
const { RabbitMQService } = require("./services/rabbitmq.service");
const { DatabaseService } = require("./services/database.service");
const { ProtocolParser } = require("./protocol-parser");
const { DeviceManager } = require("./device-manager");
const { Logger } = require("./utils/logger");

/**
 * TCP Server para comunicação com dispositivos GPS
 * Recebe dados dos trackers e envia comandos remotos
 */
class TCPServer extends EventEmitter {
  constructor(port = 5000, host = "0.0.0.0") {
    super();

    this.port = port;
    this.host = host;
    this.connectedDevices = new Map(); // Map<imei, DeviceConnection>

    // Inicializar serviços
    this.logger = new Logger("TCP-SERVER");
    this.rabbitMQ = new RabbitMQService();
    this.database = new DatabaseService();
    this.parser = new ProtocolParser();
    this.deviceManager = new DeviceManager();

    // Criar servidor TCP
    this.server = net.createServer();
    this.setupServer();
  }

  /**
   * Configurar eventos do servidor TCP
   */
  setupServer() {
    this.server.on("connection", (socket) => this.handleConnection(socket));
    this.server.on("error", (error) => this.handleServerError(error));
    this.server.on("listening", () => {
      this.logger.info(`TCP Server listening on ${this.host}:${this.port}`);
    });
  }

  /**
   * Inicializar servidor e serviços
   */
  async start() {
    try {
      // Conectar RabbitMQ
      await this.rabbitMQ.connect();
      this.logger.info("RabbitMQ connected");

      // Configurar consumer para comandos
      await this.setupCommandConsumer();

      // Iniciar servidor TCP
      return new Promise((resolve, reject) => {
        this.server.listen(this.port, this.host, () => {
          this.logger.info("TCP Server started successfully");
          resolve();
        });
        this.server.on("error", reject);
      });
    } catch (error) {
      this.logger.error("Failed to start TCP Server:", error);
      throw error;
    }
  }

  /**
   * Configurar consumer RabbitMQ para comandos de dispositivos
   */
  async setupCommandConsumer() {
    await this.rabbitMQ.consumeQueue("device_commands", async (message) => {
      try {
        await this.handleDeviceCommand(message);
      } catch (error) {
        this.logger.error("Error processing device command:", error);
      }
    });

    this.logger.info("Command consumer configured");
  }

  /**
   * Manipular nova conexão TCP
   */
  async handleConnection(socket) {
    const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.info(`New connection from ${clientInfo}`);

    // Criar objeto de conexão do dispositivo
    const deviceConnection = {
      socket,
      imei: null,
      authenticated: false,
      lastSeen: new Date(),
      buffer: Buffer.alloc(0), // Buffer para dados incompletos
    };

    // Timeout para autenticação (30 segundos)
    const authTimeout = setTimeout(() => {
      if (!deviceConnection.authenticated) {
        this.logger.warn(`Authentication timeout for ${clientInfo}`);
        socket.destroy();
      }
    }, 30000);

    // Eventos do socket
    socket.on("data", async (data) => {
      try {
        clearTimeout(authTimeout);
        await this.handleDeviceData(deviceConnection, data);
        deviceConnection.lastSeen = new Date();
      } catch (error) {
        this.logger.error(`Error processing data from ${clientInfo}:`, error);
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimeout);
      this.handleDisconnection(deviceConnection);
      this.logger.info(`Connection closed for ${clientInfo}`);
    });

    socket.on("error", (error) => {
      this.logger.error(`Socket error for ${clientInfo}:`, error);
      clearTimeout(authTimeout);
      this.handleDisconnection(deviceConnection);
    });
  }

  /**
   * Processar dados recebidos do dispositivo
   */
  async handleDeviceData(deviceConnection, data) {
    // Adicionar dados ao buffer (para mensagens fragmentadas)
    deviceConnection.buffer = Buffer.concat([deviceConnection.buffer, data]);

    const hexData = data.toString("hex").toUpperCase();
    const asciiData = data.toString("ascii");
    this.logger.info(`🔍 RAW DATA HEX: ${hexData}`);
    this.logger.info(`🔍 RAW DATA ASCII: ${asciiData}`);
    this.logger.debug(`Received data: ${hexData}`);

    try {
      // Tentar fazer parse dos dados
      const parseResult = this.parser.parse(deviceConnection.buffer);

      if (!parseResult.success) {
        // Se não conseguiu fazer parse, aguardar mais dados
        if (deviceConnection.buffer.length > 1024) {
          // Limpar buffer se ficou muito grande
          this.logger.warn("Buffer too large, clearing");
          deviceConnection.buffer = Buffer.alloc(0);
        }
        return;
      }

      // Parse bem-sucedido, remover dados processados do buffer
      deviceConnection.buffer = deviceConnection.buffer.slice(
        parseResult.bytesProcessed
      );

      const parsedData = parseResult.data;

      // Para GPS303, mensagem de login não tem IMEI ainda
      if (parsedData.type === "login" && parsedData.protocol === "gps303") {
        this.logger.info("🔓 GPS303 login detected, sending LOAD response");
        const response = Buffer.from("LOAD", "ascii");
        deviceConnection.socket.write(response);
        return;
      }

      // Primeira mensagem deve conter IMEI para autenticação
      if (!deviceConnection.authenticated && parsedData.imei) {
        await this.authenticateDevice(deviceConnection, parsedData.imei);
      }

      if (!deviceConnection.authenticated && parsedData.type !== "login") {
        this.logger.warn("Device not authenticated, dropping message");
        return;
      }

      // Processar diferentes tipos de mensagem
      switch (parsedData.type) {
        case "login":
          await this.handleLogin(deviceConnection, parsedData);
          break;
        case "location":
          await this.handleLocationData(deviceConnection, parsedData);
          break;
        case "heartbeat":
          await this.handleHeartbeat(deviceConnection, parsedData);
          break;
        case "alarm":
          await this.handleAlarmData(deviceConnection, parsedData);
          break;
        case "response":
          await this.handleCommandResponse(deviceConnection, parsedData);
          break;
        default:
          this.logger.warn(`Unknown message type: ${parsedData.type}`);
      }
    } catch (error) {
      this.logger.error("Error parsing device data:", error);
      // Limpar buffer em caso de erro
      deviceConnection.buffer = Buffer.alloc(0);
    }
  }

  /**
   * Autenticar dispositivo pelo IMEI
   */
  async authenticateDevice(deviceConnection, imei) {
    try {
      this.logger.debug(`Attempting to authenticate device with IMEI: ${imei}`);

      // Verificar se dispositivo existe no banco
      const deviceRecord = await this.database.getDeviceByImei(imei);

      if (!deviceRecord) {
        this.logger.warn(`Unknown device IMEI: ${imei}`);
        deviceConnection.socket.destroy();
        return;
      }

      this.logger.debug(
        `Device found in database: ${JSON.stringify(deviceRecord)}`
      );

      deviceConnection.imei = imei;
      deviceConnection.authenticated = true;

      // Registrar dispositivo como conectado
      this.connectedDevices.set(imei, deviceConnection);
      await this.deviceManager.setDeviceOnline(imei, true);

      this.logger.info(`Device ${imei} authenticated and connected`);

      // Enviar resposta de autenticação
      await this.sendAuthResponse(deviceConnection, true);
    } catch (error) {
      this.logger.error(`Authentication error for IMEI ${imei}:`, error);
      this.logger.error(`Error details:`, {
        message: error.message,
        stack: error.stack,
        code: error.code,
      });
      deviceConnection.socket.destroy();
    }
  }

  /**
   * Manipular login do dispositivo
   */
  async handleLogin(deviceConnection, data) {
    this.logger.info(`Login received from device ${deviceConnection.imei}`);

    // Atualizar último login no banco
    await this.deviceManager.updateLastLogin(deviceConnection.imei);

    // Enviar confirmação de login
    const loginResponse = this.parser.buildLoginResponse(true);
    if (loginResponse) {
      deviceConnection.socket.write(loginResponse);
    }
  }

  /**
   * Manipular dados de localização
   */
  async handleLocationData(deviceConnection, data) {
    try {
      // Obter ID do dispositivo
      const deviceId = await this.database.getDeviceIdByImei(
        deviceConnection.imei
      );

      // Salvar localização no banco
      await this.database.saveLocation({
        device_id: deviceId,
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed || 0,
        timestamp: data.timestamp || new Date(),
      });

      // Publicar no RabbitMQ para processamento adicional
      await this.rabbitMQ.publishToQueue("tracker_messages", {
        type: "location",
        imei: deviceConnection.imei,
        device_id: deviceId,
        data: data,
        received_at: new Date(),
      });

      // Enviar ACK para o dispositivo
      await this.sendLocationAck(deviceConnection, data.sequence || 0);

      this.logger.debug(
        `Location saved for device ${deviceConnection.imei} - Lat: ${data.latitude}, Lon: ${data.longitude}`
      );
    } catch (error) {
      this.logger.error(
        `Error saving location for ${deviceConnection.imei}:`,
        error
      );
    }
  }

  /**
   * Manipular heartbeat
   */
  async handleHeartbeat(deviceConnection, data) {
    // Atualizar último heartbeat
    await this.deviceManager.updateLastHeartbeat(deviceConnection.imei);

    // Responder heartbeat
    const heartbeatResponse = this.parser.buildHeartbeatResponse();
    if (heartbeatResponse) {
      deviceConnection.socket.write(heartbeatResponse);
    }

    this.logger.debug(`Heartbeat received from ${deviceConnection.imei}`);
  }

  /**
   * Manipular dados de alarme
   */
  async handleAlarmData(deviceConnection, data) {
    try {
      const deviceId = await this.database.getDeviceIdByImei(
        deviceConnection.imei
      );

      // Salvar alarme no banco
      await this.database.saveAlert({
        device_id: deviceId,
        alert_type: data.alarmType,
        message: data.message || "Alarm triggered",
        latitude: data.latitude,
        longitude: data.longitude,
        timestamp: data.timestamp || new Date(),
        raw_data: data.raw || null,
      });

      // Publicar alarme no RabbitMQ
      await this.rabbitMQ.publishToQueue("device_alerts", {
        type: "alarm",
        imei: deviceConnection.imei,
        device_id: deviceId,
        alarmType: data.alarmType,
        data: data,
        received_at: new Date(),
      });

      this.logger.warn(
        `Alarm received from ${deviceConnection.imei}: ${data.alarmType}`
      );
    } catch (error) {
      this.logger.error(
        `Error processing alarm from ${deviceConnection.imei}:`,
        error
      );
    }
  }

  /**
   * Manipular resposta de comando
   */
  async handleCommandResponse(deviceConnection, data) {
    try {
      // Atualizar status do comando no banco
      if (data.commandId) {
        await this.database.updateCommandStatus(
          data.commandId,
          "acknowledged",
          {
            response: data.response,
            ack_at: new Date(),
          }
        );

        this.logger.info(
          `Command ${data.commandId} acknowledged by ${deviceConnection.imei}`
        );
      }
    } catch (error) {
      this.logger.error(`Error updating command status:`, error);
    }
  }

  /**
   * Processar comando para enviar ao dispositivo
   */
  async handleDeviceCommand(message) {
    try {
      const { imei, command, parameters, commandId } = message;

      const deviceConnection = this.connectedDevices.get(imei);
      if (!deviceConnection) {
        this.logger.warn(`Device ${imei} not connected, cannot send command`);

        // Marcar comando como falhou
        await this.database.updateCommandStatus(commandId, "failed", {
          error: "Device not connected",
          failed_at: new Date(),
        });
        return;
      }

      // Construir comando baseado no protocolo
      const commandBuffer = this.parser.buildCommand(command, parameters);

      if (!commandBuffer) {
        this.logger.error(`Failed to build command: ${command}`);
        await this.database.updateCommandStatus(commandId, "failed", {
          error: "Invalid command format",
          failed_at: new Date(),
        });
        return;
      }

      // Enviar comando para dispositivo
      deviceConnection.socket.write(commandBuffer);

      // Marcar como enviado
      await this.database.updateCommandStatus(commandId, "sent", {
        sent_at: new Date(),
      });

      this.logger.info(`Command ${command} sent to device ${imei}`);
    } catch (error) {
      this.logger.error("Error sending command to device:", error);
    }
  }

  /**
   * Enviar resposta de autenticação
   */
  async sendAuthResponse(deviceConnection, success) {
    const response = this.parser.buildAuthResponse(success);
    if (response) {
      deviceConnection.socket.write(response);
    }
  }

  /**
   * Enviar ACK de localização
   */
  async sendLocationAck(deviceConnection, sequence) {
    const ack = this.parser.buildLocationAck(sequence);
    if (ack) {
      deviceConnection.socket.write(ack);
    }
  }

  /**
   * Manipular desconexão de dispositivo
   */
  handleDisconnection(deviceConnection) {
    if (deviceConnection.imei) {
      this.connectedDevices.delete(deviceConnection.imei);
      this.deviceManager.setDeviceOnline(deviceConnection.imei, false);
      this.logger.info(`Device ${deviceConnection.imei} disconnected`);
    }
  }

  /**
   * Manipular erro do servidor
   */
  handleServerError(error) {
    this.logger.error("TCP Server error:", error);
  }

  /**
   * Parar servidor
   */
  async stop() {
    // Fechar todas as conexões
    for (const deviceConnection of this.connectedDevices.values()) {
      deviceConnection.socket.destroy();
    }

    this.connectedDevices.clear();

    // Fechar servidor
    return new Promise((resolve) => {
      this.server.close(() => {
        this.logger.info("TCP Server stopped");
        resolve();
      });
    });
  }

  /**
   * Obter dispositivos conectados
   */
  getConnectedDevices() {
    return Array.from(this.connectedDevices.keys());
  }

  /**
   * Verificar se dispositivo está conectado
   */
  isDeviceConnected(imei) {
    return this.connectedDevices.has(imei);
  }

  /**
   * Obter estatísticas do servidor
   */
  getStats() {
    return {
      connectedDevices: this.connectedDevices.size,
      serverPort: this.port,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    };
  }
}

module.exports = { TCPServer };
