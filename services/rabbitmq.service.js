const amqp = require("amqplib");

/**
 * Serviço para comunicação com RabbitMQ
 * Gerencia filas, publishers e consumers
 */
class RabbitMQService {
  constructor(url = null) {
    this.url =
      url ||
      process.env.RABBITMQ_URL ||
      "amqp://traksure:traksure_pass@localhost:5672";
    this.connection = null;
    this.channel = null;
    this.consumers = new Map();
  }

  /**
   * Conectar ao RabbitMQ
   */
  async connect() {
    try {
      console.log(
        "Connecting to RabbitMQ:",
        this.url.replace(/\/\/.*@/, "//***:***@")
      );

      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();

      // Configurar exchanges e filas padrão
      await this.setupQueues();

      // Eventos de erro
      this.connection.on("error", (err) => {
        console.error("RabbitMQ connection error:", err);
      });

      this.connection.on("close", () => {
        console.warn("RabbitMQ connection closed");
      });

      console.log("RabbitMQ connected successfully");
    } catch (error) {
      console.error("Failed to connect to RabbitMQ:", error);
      throw error;
    }
  }

  /**
   * Configurar filas e exchanges necessários
   */
  async setupQueues() {
    const queues = [
      "device_commands", // Comandos para enviar aos dispositivos
      "tracker_messages", // Mensagens recebidas dos trackers
      "device_alerts", // Alertas dos dispositivos
      "location_updates", // Atualizações de localização
    ];

    for (const queue of queues) {
      await this.channel.assertQueue(queue, {
        durable: true, // Persistir fila após restart
        maxLength: 10000, // Máximo de 10k mensagens na fila
      });
    }

    console.log("RabbitMQ queues configured:", queues);
  }

  /**
   * Publicar mensagem em uma fila
   */
  async publishToQueue(queueName, message, options = {}) {
    try {
      if (!this.channel) {
        throw new Error("RabbitMQ not connected");
      }

      const messageBuffer = Buffer.from(JSON.stringify(message));

      const success = this.channel.sendToQueue(queueName, messageBuffer, {
        persistent: true,
        timestamp: Date.now(),
        ...options,
      });

      if (!success) {
        console.warn(`Queue ${queueName} is full, message may be lost`);
      }

      return success;
    } catch (error) {
      console.error(`Failed to publish to queue ${queueName}:`, error);
      throw error;
    }
  }

  /**
   * Consumir mensagens de uma fila
   */
  async consumeQueue(queueName, handler, options = {}) {
    try {
      if (!this.channel) {
        throw new Error("RabbitMQ not connected");
      }

      const consumerTag = await this.channel.consume(
        queueName,
        async (msg) => {
          if (msg === null) return;

          try {
            const message = JSON.parse(msg.content.toString());

            // Executar handler
            await handler(message);

            // ACK da mensagem após processamento bem-sucedido
            this.channel.ack(msg);
          } catch (error) {
            console.error(`Error processing message from ${queueName}:`, error);

            // NACK da mensagem (vai para DLQ se configurado)
            this.channel.nack(msg, false, false);
          }
        },
        {
          noAck: false,
          ...options,
        }
      );

      this.consumers.set(queueName, consumerTag.consumerTag);
      console.log(`Consumer started for queue: ${queueName}`);

      return consumerTag.consumerTag;
    } catch (error) {
      console.error(`Failed to consume queue ${queueName}:`, error);
      throw error;
    }
  }

  /**
   * Parar consumer de uma fila
   */
  async stopConsumer(queueName) {
    const consumerTag = this.consumers.get(queueName);
    if (consumerTag) {
      await this.channel.cancel(consumerTag);
      this.consumers.delete(queueName);
      console.log(`Consumer stopped for queue: ${queueName}`);
    }
  }

  /**
   * Publicar comando para dispositivo
   */
  async publishDeviceCommand(imei, command, parameters = {}, commandId = null) {
    return await this.publishToQueue("device_commands", {
      imei,
      command,
      parameters,
      commandId,
      timestamp: new Date(),
      source: "api",
    });
  }

  /**
   * Publicar mensagem de tracker
   */
  async publishTrackerMessage(imei, type, data) {
    return await this.publishToQueue("tracker_messages", {
      imei,
      type,
      data,
      timestamp: new Date(),
      source: "tcp-server",
    });
  }

  /**
   * Publicar alerta de dispositivo
   */
  async publishDeviceAlert(imei, alertType, data) {
    return await this.publishToQueue("device_alerts", {
      imei,
      alertType,
      data,
      timestamp: new Date(),
      priority: "high",
    });
  }

  /**
   * Obter estatísticas das filas
   */
  async getQueueStats(queueName) {
    try {
      const queueInfo = await this.channel.checkQueue(queueName);
      return {
        queue: queueName,
        messageCount: queueInfo.messageCount,
        consumerCount: queueInfo.consumerCount,
      };
    } catch (error) {
      console.error(`Failed to get stats for queue ${queueName}:`, error);
      return null;
    }
  }

  /**
   * Obter estatísticas de todas as filas
   */
  async getAllQueueStats() {
    const queues = [
      "device_commands",
      "tracker_messages",
      "device_alerts",
      "location_updates",
    ];
    const stats = {};

    for (const queue of queues) {
      stats[queue] = await this.getQueueStats(queue);
    }

    return stats;
  }

  /**
   * Limpar uma fila (remover todas as mensagens)
   */
  async purgeQueue(queueName) {
    try {
      const result = await this.channel.purgeQueue(queueName);
      console.log(
        `Purged ${result.messageCount} messages from queue ${queueName}`
      );
      return result.messageCount;
    } catch (error) {
      console.error(`Failed to purge queue ${queueName}:`, error);
      throw error;
    }
  }

  /**
   * Fechar conexão
   */
  async close() {
    try {
      // Parar todos os consumers
      for (const queueName of this.consumers.keys()) {
        await this.stopConsumer(queueName);
      }

      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }

      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }

      console.log("RabbitMQ connection closed");
    } catch (error) {
      console.error("Error closing RabbitMQ connection:", error);
    }
  }

  /**
   * Verificar se está conectado
   */
  isConnected() {
    return (
      this.connection &&
      this.channel &&
      !this.connection.connection.stream.destroyed
    );
  }

  /**
   * Reconectar em caso de falha
   */
  async reconnect() {
    await this.close();
    await this.connect();
  }
}

module.exports = { RabbitMQService };
