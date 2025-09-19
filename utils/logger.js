const fs = require("fs");
const path = require("path");

/**
 * Sistema de logging customizado para TCP Server
 * Suporta diferentes níveis e saída para arquivo/console
 */
class Logger {
  constructor(context = "APP", options = {}) {
    this.context = context;
    this.logLevel = options.logLevel || process.env.LOG_LEVEL || "info";
    this.logToFile = options.logToFile !== undefined ? options.logToFile : true;
    this.logToConsole =
      options.logToConsole !== undefined ? options.logToConsole : true;
    this.logDir = options.logDir || path.join(process.cwd(), "logs");
    this.maxLogSize = options.maxLogSize || 10 * 1024 * 1024; // 10MB
    this.maxLogFiles = options.maxLogFiles || 5;

    // Níveis de log
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
    };

    this.currentLevel = this.levels[this.logLevel] || this.levels.info;

    // Criar diretório de logs se necessário
    if (this.logToFile) {
      this.ensureLogDirectory();
    }

    // Nome do arquivo de log
    this.logFileName = `tcp-server-${
      new Date().toISOString().split("T")[0]
    }.log`;
    this.logFilePath = path.join(this.logDir, this.logFileName);
  }

  /**
   * Garantir que o diretório de logs existe
   */
  ensureLogDirectory() {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (error) {
      console.error("Failed to create log directory:", error);
    }
  }

  /**
   * Formatar mensagem de log
   */
  formatMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const pid = process.pid;

    let formattedMessage = `[${timestamp}] [${pid}] [${level.toUpperCase()}] [${
      this.context
    }] ${message}`;

    if (data !== null && data !== undefined) {
      if (typeof data === "object") {
        formattedMessage += ` | Data: ${JSON.stringify(data, null, 2)}`;
      } else {
        formattedMessage += ` | Data: ${data}`;
      }
    }

    return formattedMessage;
  }

  /**
   * Escrever log em arquivo
   */
  writeToFile(message) {
    if (!this.logToFile) return;

    try {
      // Verificar se precisa rotacionar o log
      this.rotateLogIfNeeded();

      fs.appendFileSync(this.logFilePath, message + "\n", "utf8");
    } catch (error) {
      console.error("Failed to write log to file:", error);
    }
  }

  /**
   * Rotacionar log se necessário
   */
  rotateLogIfNeeded() {
    try {
      if (!fs.existsSync(this.logFilePath)) return;

      const stats = fs.statSync(this.logFilePath);

      if (stats.size >= this.maxLogSize) {
        // Renomear arquivo atual
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const rotatedName = `tcp-server-${timestamp}.log`;
        const rotatedPath = path.join(this.logDir, rotatedName);

        fs.renameSync(this.logFilePath, rotatedPath);

        // Limpar logs antigos
        this.cleanOldLogs();
      }
    } catch (error) {
      console.error("Failed to rotate log:", error);
    }
  }

  /**
   * Limpar logs antigos
   */
  cleanOldLogs() {
    try {
      const files = fs
        .readdirSync(this.logDir)
        .filter(
          (file) => file.startsWith("tcp-server-") && file.endsWith(".log")
        )
        .map((file) => ({
          name: file,
          path: path.join(this.logDir, file),
          stats: fs.statSync(path.join(this.logDir, file)),
        }))
        .sort((a, b) => b.stats.mtime - a.stats.mtime);

      // Manter apenas os arquivos mais recentes
      if (files.length > this.maxLogFiles) {
        const filesToDelete = files.slice(this.maxLogFiles);

        for (const file of filesToDelete) {
          fs.unlinkSync(file.path);
        }
      }
    } catch (error) {
      console.error("Failed to clean old logs:", error);
    }
  }

  /**
   * Log genérico
   */
  log(level, message, data = null) {
    const levelNum = this.levels[level];

    if (levelNum === undefined || levelNum > this.currentLevel) {
      return; // Não logar se o nível está desabilitado
    }

    const formattedMessage = this.formatMessage(level, message, data);

    // Output para console
    if (this.logToConsole) {
      switch (level) {
        case "error":
          console.error(formattedMessage);
          break;
        case "warn":
          console.warn(formattedMessage);
          break;
        case "debug":
          console.debug(formattedMessage);
          break;
        default:
          console.log(formattedMessage);
      }
    }

    // Output para arquivo
    this.writeToFile(formattedMessage);
  }

  /**
   * Log de erro
   */
  error(message, data = null) {
    this.log("error", message, data);
  }

  /**
   * Log de warning
   */
  warn(message, data = null) {
    this.log("warn", message, data);
  }

  /**
   * Log de informação
   */
  info(message, data = null) {
    this.log("info", message, data);
  }

  /**
   * Log de debug
   */
  debug(message, data = null) {
    this.log("debug", message, data);
  }

  /**
   * Log com contexto específico
   */
  withContext(context) {
    return new Logger(context, {
      logLevel: this.logLevel,
      logToFile: this.logToFile,
      logToConsole: this.logToConsole,
      logDir: this.logDir,
    });
  }

  /**
   * Log de performance
   */
  logPerformance(operation, startTime, data = null) {
    const duration = Date.now() - startTime;
    this.info(`Performance: ${operation} took ${duration}ms`, data);
  }

  /**
   * Log de conexão de dispositivo
   */
  logDeviceConnection(imei, action, details = null) {
    this.info(`Device ${action}: ${imei}`, details);
  }

  /**
   * Log de dados recebidos (hex)
   */
  logDataReceived(imei, data, protocol = null) {
    const hex = data.toString("hex").toUpperCase();
    const context = protocol ? `[${protocol}]` : "";
    this.debug(`Data received ${context} from ${imei}: ${hex}`);
  }

  /**
   * Log de comando enviado
   */
  logCommandSent(imei, command, success = true) {
    const level = success ? "info" : "warn";
    const status = success ? "sent" : "failed";
    this.log(level, `Command ${status}: ${command} to ${imei}`);
  }

  /**
   * Obter estatísticas de logs
   */
  getLogStats() {
    try {
      const stats = {
        logLevel: this.logLevel,
        context: this.context,
        logToFile: this.logToFile,
        logToConsole: this.logToConsole,
        logDir: this.logDir,
      };

      if (this.logToFile && fs.existsSync(this.logFilePath)) {
        const fileStats = fs.statSync(this.logFilePath);
        stats.currentLogFile = {
          name: this.logFileName,
          size: fileStats.size,
          created: fileStats.birthtime,
          modified: fileStats.mtime,
        };
      }

      return stats;
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Alterar nível de log dinamicamente
   */
  setLogLevel(level) {
    if (this.levels[level] !== undefined) {
      this.logLevel = level;
      this.currentLevel = this.levels[level];
      this.info(`Log level changed to: ${level}`);
    } else {
      this.warn(`Invalid log level: ${level}`);
    }
  }

  /**
   * Flush logs (forçar escrita)
   */
  flush() {
    // Em Node.js, fs.appendFileSync já faz flush automático
    // Esta função existe para compatibilidade
    this.debug("Log flush requested");
  }
}

module.exports = { Logger };
