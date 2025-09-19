#!/usr/bin/env node

/**
 * TrakSure TCP Server
 * Servidor principal para comunicação com dispositivos GPS
 */

const { TCPServer } = require("./tcp-server");
const { Logger } = require("./utils/logger");
const dotenv = require("dotenv");

// Carregar variáveis de ambiente
dotenv.config();

// Configurações
const PORT = process.env.TCP_PORT || 5000;
const HOST = process.env.TCP_HOST || "0.0.0.0";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// Logger principal
const logger = new Logger("MAIN", {
  logLevel: LOG_LEVEL,
  logToFile: true,
  logToConsole: true,
});

// Instância do servidor TCP
let tcpServer = null;

/**
 * Inicializar servidor
 */
async function startServer() {
  try {
    logger.info("Starting TrakSure TCP Server...");
    logger.info(
      `Configuration: Host=${HOST}, Port=${PORT}, LogLevel=${LOG_LEVEL}`
    );

    // Criar e iniciar servidor TCP
    tcpServer = new TCPServer(PORT, HOST);
    await tcpServer.start();

    logger.info("TrakSure TCP Server started successfully");

    // Log de estatísticas a cada 5 minutos
    setInterval(async () => {
      try {
        const stats = tcpServer.getStats();
        logger.info("Server Statistics", stats);
      } catch (error) {
        logger.error("Error getting server stats:", error);
      }
    }, 300000); // 5 minutos
  } catch (error) {
    logger.error("Failed to start TCP Server:", error);
    process.exit(1);
  }
}

/**
 * Parar servidor graciosamente
 */
async function stopServer() {
  try {
    logger.info("Stopping TrakSure TCP Server...");

    if (tcpServer) {
      await tcpServer.stop();
    }

    logger.info("TrakSure TCP Server stopped successfully");
    process.exit(0);
  } catch (error) {
    logger.error("Error stopping server:", error);
    process.exit(1);
  }
}

/**
 * Manipular sinais do sistema
 */
function setupSignalHandlers() {
  // SIGINT (Ctrl+C)
  process.on("SIGINT", () => {
    logger.info("Received SIGINT, shutting down gracefully");
    stopServer();
  });

  // SIGTERM (PM2 stop)
  process.on("SIGTERM", () => {
    logger.info("Received SIGTERM, shutting down gracefully");
    stopServer();
  });

  // Uncaught exceptions
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught Exception:", error);
    stopServer();
  });

  // Unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled Rejection at:", promise, "reason:", reason);
    stopServer();
  });
}

/**
 * Função principal
 */
async function main() {
  try {
    logger.info("TrakSure TCP Server starting up...");
    logger.info(`Node.js version: ${process.version}`);
    logger.info(`Platform: ${process.platform}`);
    logger.info(`PID: ${process.pid}`);

    // Configurar handlers de sinal
    setupSignalHandlers();

    // Iniciar servidor
    await startServer();
  } catch (error) {
    logger.error("Fatal error during startup:", error);
    process.exit(1);
  }
}

// Verificar se está sendo executado diretamente
if (require.main === module) {
  main();
}

module.exports = {
  startServer,
  stopServer,
  logger,
};
