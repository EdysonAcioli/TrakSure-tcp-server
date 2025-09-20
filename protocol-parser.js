/**
 * Parser de protocolos para diferentes dispositivos GPS
 * Suporta múltiplos protocolos: GT06, TK103, H02, etc.
 */

class ProtocolParser {
  constructor() {
    this.parsers = {
      gps303: new GPS303Parser(),
      gt06: new GT06Parser(),
      tk103: new TK103Parser(),
      h02: new H02Parser(),
      generic: new GenericParser(),
    };

    this.defaultParser = "gps303"; // Priorizar GPS303
  }

  /**
   * Fazer parse dos dados recebidos
   * Tenta identificar automaticamente o protocolo
   */
  parse(buffer) {
    // Tentar parsers específicos primeiro
    for (const [protocol, parser] of Object.entries(this.parsers)) {
      if (protocol === "generic") continue;

      try {
        const result = parser.parse(buffer);
        if (result.success) {
          result.protocol = protocol;
          return result;
        }
      } catch (error) {
        // Continue tentando outros parsers
      }
    }

    // Se nenhum parser específico funcionou, usar genérico
    try {
      const result = this.parsers.generic.parse(buffer);
      result.protocol = "generic";
      return result;
    } catch (error) {
      return {
        success: false,
        error: "Failed to parse data with any protocol",
        bytesProcessed: 0,
      };
    }
  }

  /**
   * Construir comando para enviar ao dispositivo
   */
  buildCommand(command, parameters, protocol = null) {
    const parser = protocol
      ? this.parsers[protocol]
      : this.parsers[this.defaultParser];

    if (!parser) {
      throw new Error(`Unknown protocol: ${protocol}`);
    }

    return parser.buildCommand(command, parameters);
  }

  /**
   * Construir resposta de autenticação
   */
  buildAuthResponse(success, protocol = null) {
    const parser = protocol
      ? this.parsers[protocol]
      : this.parsers[this.defaultParser];
    return parser ? parser.buildAuthResponse(success) : null;
  }

  /**
   * Construir resposta de login
   */
  buildLoginResponse(success, protocol = null) {
    const parser = protocol
      ? this.parsers[protocol]
      : this.parsers[this.defaultParser];
    return parser ? parser.buildLoginResponse(success) : null;
  }

  /**
   * Construir ACK de localização
   */
  buildLocationAck(sequence, protocol = null) {
    const parser = protocol
      ? this.parsers[protocol]
      : this.parsers[this.defaultParser];
    return parser ? parser.buildLocationAck(sequence) : null;
  }

  /**
   * Construir resposta de heartbeat
   */
  buildHeartbeatResponse(protocol = null) {
    const parser = protocol
      ? this.parsers[protocol]
      : this.parsers[this.defaultParser];
    return parser ? parser.buildHeartbeatResponse() : null;
  }
}

/**
 * Parser para protocolo GT06 (muito comum em trackers chineses)
 */
class GT06Parser {
  constructor() {
    this.START_BIT = 0x78;
    this.STOP_BIT = 0x0d;
    this.STOP_BIT2 = 0x0a;
  }

  parse(buffer) {
    if (buffer.length < 5) {
      return { success: false, error: "Buffer too small" };
    }

    // Verificar start bits
    if (buffer[0] !== this.START_BIT || buffer[1] !== this.START_BIT) {
      return { success: false, error: "Invalid start bits" };
    }

    const length = buffer[2];
    const totalLength = length + 5; // start(2) + length(1) + data(length) + crc(2)

    if (buffer.length < totalLength) {
      return { success: false, error: "Incomplete packet" };
    }

    // Verificar stop bits
    if (
      buffer[totalLength - 2] !== this.STOP_BIT ||
      buffer[totalLength - 1] !== this.STOP_BIT2
    ) {
      return { success: false, error: "Invalid stop bits" };
    }

    const protocolNumber = buffer[3];
    const data = buffer.slice(4, 3 + length - 1); // Excluir CRC

    let parsedData = null;

    switch (protocolNumber) {
      case 0x01: // Login
        parsedData = this.parseLogin(data);
        break;
      case 0x12: // Location data
        parsedData = this.parseLocation(data);
        break;
      case 0x13: // Heartbeat
        parsedData = this.parseHeartbeat(data);
        break;
      case 0x16: // Alarm
        parsedData = this.parseAlarm(data);
        break;
      case 0x15: // Command response
        parsedData = this.parseCommandResponse(data);
        break;
      default:
        parsedData = {
          type: "unknown",
          protocolNumber: protocolNumber,
          data: data,
        };
    }

    return {
      success: true,
      data: parsedData,
      bytesProcessed: totalLength,
    };
  }

  parseLogin(data) {
    // Login data: IMEI (8 bytes) + Type ID (2 bytes)
    if (data.length < 10) {
      throw new Error("Invalid login data length");
    }

    const imei = this.parseIMEI(data.slice(0, 8));
    const typeId = data.readUInt16BE(8);

    return {
      type: "login",
      imei: imei,
      typeId: typeId,
    };
  }

  parseLocation(data) {
    if (data.length < 21) {
      throw new Error("Invalid location data length");
    }

    const dateTime = this.parseDateTime(data.slice(0, 6));
    const quantity = data[6];
    const latitude = this.parseCoordinate(data.slice(7, 11));
    const longitude = this.parseCoordinate(data.slice(11, 15));
    const speed = data[15];
    const course = data.readUInt16BE(16);
    const lbsLength = data[18];

    return {
      type: "location",
      timestamp: dateTime,
      latitude: latitude,
      longitude: longitude,
      speed: speed,
      course: course,
      satellites: quantity & 0x0f,
      gpsFixed: (quantity & 0x10) > 0,
    };
  }

  parseHeartbeat(data) {
    return {
      type: "heartbeat",
      timestamp: new Date(),
      data: data,
    };
  }

  parseAlarm(data) {
    if (data.length < 21) {
      throw new Error("Invalid alarm data length");
    }

    const dateTime = this.parseDateTime(data.slice(0, 6));
    const quantity = data[6];
    const latitude = this.parseCoordinate(data.slice(7, 11));
    const longitude = this.parseCoordinate(data.slice(11, 15));
    const speed = data[15];
    const course = data.readUInt16BE(16);
    const alarmType = data[18];

    let alarmMessage = "Unknown alarm";
    switch (alarmType) {
      case 0x00:
        alarmMessage = "Normal";
        break;
      case 0x01:
        alarmMessage = "SOS";
        break;
      case 0x02:
        alarmMessage = "Power Cut";
        break;
      case 0x03:
        alarmMessage = "Vibration";
        break;
      case 0x04:
        alarmMessage = "Fence In";
        break;
      case 0x05:
        alarmMessage = "Fence Out";
        break;
      case 0x06:
        alarmMessage = "Over Speed";
        break;
    }

    return {
      type: "alarm",
      timestamp: dateTime,
      latitude: latitude,
      longitude: longitude,
      speed: speed,
      course: course,
      alarmType: alarmMessage,
      alarmCode: alarmType,
    };
  }

  parseCommandResponse(data) {
    return {
      type: "response",
      timestamp: new Date(),
      response: data.toString("hex"),
      data: data,
    };
  }

  parseIMEI(buffer) {
    // IMEI está codificado em BCD
    let imei = "";
    for (let i = 0; i < buffer.length; i++) {
      imei += buffer[i].toString(16).padStart(2, "0");
    }
    return imei;
  }

  parseDateTime(buffer) {
    const year = 2000 + buffer[0];
    const month = buffer[1] - 1; // JavaScript months are 0-based
    const day = buffer[2];
    const hour = buffer[3];
    const minute = buffer[4];
    const second = buffer[5];

    return new Date(year, month, day, hour, minute, second);
  }

  parseCoordinate(buffer) {
    const value = buffer.readUInt32BE(0);
    return value / 1800000.0; // Converter para graus decimais
  }

  // Comandos para enviar ao dispositivo
  buildCommand(command, parameters) {
    switch (command) {
      case "locate":
        return this.buildLocateCommand();
      case "reboot":
        return this.buildRebootCommand();
      case "engine_stop":
        return this.buildEngineCommand(true);
      case "engine_resume":
        return this.buildEngineCommand(false);
      default:
        return null;
    }
  }

  buildLocateCommand() {
    // Comando para solicitar posição atual
    const data = Buffer.from([0x80, 0x01, 0x01, 0x01]);
    return this.wrapCommand(data);
  }

  buildRebootCommand() {
    // Comando para reiniciar dispositivo
    const data = Buffer.from([0x80, 0x02, 0x01, 0x01]);
    return this.wrapCommand(data);
  }

  buildEngineCommand(stop) {
    // Comando para parar/religar motor
    const action = stop ? 0x01 : 0x00;
    const data = Buffer.from([0x80, 0x05, 0x01, action]);
    return this.wrapCommand(data);
  }

  wrapCommand(data) {
    const length = data.length + 1; // +1 para o protocol number
    const buffer = Buffer.alloc(length + 5); // start(2) + length(1) + data + crc(2)

    buffer[0] = this.START_BIT;
    buffer[1] = this.START_BIT;
    buffer[2] = length;
    data.copy(buffer, 3);

    // CRC simples (pode ser melhorado)
    const crc = this.calculateCRC(buffer.slice(2, 3 + length));
    buffer.writeUInt16BE(crc, 3 + length);

    return buffer;
  }

  calculateCRC(data) {
    let crc = 0;
    for (let i = 0; i < data.length; i++) {
      crc += data[i];
    }
    return crc & 0xffff;
  }

  buildAuthResponse(success) {
    // Resposta de autenticação para GT06
    const response = success ? 0x01 : 0x00;
    const data = Buffer.from([0x01, response]);
    return this.wrapCommand(data);
  }

  buildLoginResponse(success) {
    // Resposta de login para GT06
    const response = success ? 0x01 : 0x00;
    const data = Buffer.from([0x01, response]);
    return this.wrapCommand(data);
  }

  buildLocationAck(sequence) {
    // ACK para dados de localização
    const data = Buffer.from([0x05, 0x01, sequence & 0xff]);
    return this.wrapCommand(data);
  }

  buildHeartbeatResponse() {
    // Resposta para heartbeat
    const data = Buffer.from([0x13, 0x01]);
    return this.wrapCommand(data);
  }
}

/**
 * Parser para protocolo TK103 (outro protocolo comum)
 */
class TK103Parser {
  parse(buffer) {
    // Implementar parser TK103
    const data = buffer.toString("ascii");

    if (data.startsWith("##")) {
      return this.parseTK103Message(data);
    }

    return { success: false, error: "Not TK103 protocol" };
  }

  parseTK103Message(message) {
    // TK103 usa mensagens ASCII
    // Exemplo: ##,imei:359710045490084,A;
    const parts = message.split(",");

    if (parts.length < 2) {
      return { success: false, error: "Invalid TK103 message" };
    }

    if (parts[1].startsWith("imei:")) {
      const imei = parts[1].substring(5);
      return {
        success: true,
        data: {
          type: "login",
          imei: imei,
        },
        bytesProcessed: Buffer.byteLength(message),
      };
    }

    return { success: false, error: "Unknown TK103 message type" };
  }

  buildCommand(command, parameters) {
    // Implementar comandos TK103
    switch (command) {
      case "locate":
        return Buffer.from("**,imei:000000000000000,C,01m;", "ascii");
      default:
        return null;
    }
  }

  buildAuthResponse(success) {
    return success ? Buffer.from("LOAD", "ascii") : null;
  }

  buildLoginResponse(success) {
    return success ? Buffer.from("LOAD", "ascii") : null;
  }

  buildLocationAck(sequence) {
    return Buffer.from("ON", "ascii");
  }

  buildHeartbeatResponse() {
    return Buffer.from("ON", "ascii");
  }
}

/**
 * Parser para protocolo H02
 */
class H02Parser {
  parse(buffer) {
    // Implementar parser H02
    return { success: false, error: "H02 parser not implemented yet" };
  }

  buildCommand(command, parameters) {
    return null;
  }

  buildAuthResponse(success) {
    return null;
  }

  buildLoginResponse(success) {
    return null;
  }

  buildLocationAck(sequence) {
    return null;
  }

  buildHeartbeatResponse() {
    return null;
  }
}

/**
 * Parser para GPS 303 (formato texto)
 */
class GPS303Parser {
  parse(buffer) {
    const data = buffer.toString('ascii');
    console.log('🔍 GPS303 Parser - Raw data:', data);

    // Verificar se é mensagem de login (começa com ##)
    if (data.startsWith('##')) {
      console.log('✅ GPS303 - Login message detected');
      return {
        success: true,
        data: {
          type: 'login',
          protocol: 'gps303',
          raw: data,
          needsResponse: 'LOAD'
        },
        bytesProcessed: buffer.length,
      };
    }

    // Verificar se é mensagem com dados de localização (começa com imei:)
    if (data.startsWith('imei:')) {
      console.log('✅ GPS303 - Location data detected');
      
      const parts = data.trim().split(',');
      if (parts.length >= 12) {
        const imei = parts[0].split(':')[1];
        const tracker = parts[1];
        const dateTime = parts[2]; // YYMMDDHHMMSS
        const empty = parts[3]; // Campo vazio
        const fix = parts[4]; // F=fix, A=valid
        const time = parts[5]; // HHMMSS.SSS
        const validity = parts[6]; // A=valid, V=invalid
        const latStr = parts[7]; // DDMM.MMMM
        const latDirection = parts[8]; // N/S
        const lonStr = parts[9]; // DDDMM.MMMM
        const lonDirection = parts[10]; // E/W
        const speed = parts[11] ? parseFloat(parts[11]) : 0;
        
        // Converter coordenadas do formato DDMM.MMMM para decimal
        const latitude = this.parseCoordinate(latStr);
        const longitude = this.parseCoordinate(lonStr);
        
        // Aplicar direção (S = negativo, W = negativo)
        const finalLat = latDirection === 'S' ? -latitude : latitude;
        const finalLon = lonDirection === 'W' ? -longitude : longitude;

        return {
          success: true,
          data: {
            type: 'location',
            protocol: 'gps303',
            imei: imei,
            latitude: finalLat,
            longitude: finalLon,
            speed: speed,
            validity: validity === 'A',
            timestamp: this.parseDateTime(dateTime, ''),
            raw: data
          },
          bytesProcessed: buffer.length,
        };
      }
    }

    return { success: false };
  }

  parseCoordinate(coordStr) {
    try {
      // Formato: DDMM.MMMM (latitude) ou DDDMM.MMMM (longitude)
      const coord = parseFloat(coordStr);
      if (isNaN(coord)) return 0;
      
      // Separar graus e minutos
      const degrees = Math.floor(coord / 100);
      const minutes = coord % 100;
      
      // Converter para graus decimais
      return degrees + (minutes / 60);
    } catch (error) {
      console.log('⚠️ GPS303 - Error parsing coordinate:', coordStr, error.message);
      return 0;
    }
  }

  parseDateTime(date, time) {
    try {
      // Se o time está vazio, extrair da string de date que contém YYMMDDHHMMSS
      if (!time || time.trim() === '') {
        if (date && date.length >= 12) {
          // date: YYMMDDHHMMSS (12 dígitos)
          const year = 2000 + parseInt(date.substring(0, 2));
          const month = parseInt(date.substring(2, 4)) - 1;
          const day = parseInt(date.substring(4, 6));
          const hour = parseInt(date.substring(6, 8));
          const minute = parseInt(date.substring(8, 10));
          const second = parseInt(date.substring(10, 12));
          
          return new Date(year, month, day, hour, minute, second);
        } else {
          // Se não conseguir fazer parse, usar data atual
          return new Date();
        }
      } else {
        // date: YYMMDD, time: HHMMSS
        const year = 2000 + parseInt(date.substring(0, 2));
        const month = parseInt(date.substring(2, 4)) - 1;
        const day = parseInt(date.substring(4, 6));
        const hour = parseInt(time.substring(0, 2));
        const minute = parseInt(time.substring(2, 4));
        const second = parseInt(time.substring(4, 6));
        
        return new Date(year, month, day, hour, minute, second);
      }
    } catch (error) {
      console.log('⚠️ GPS303 - Error parsing datetime, using current time:', error.message);
      return new Date();
    }
  }

  buildLoginResponse() {
    return Buffer.from('LOAD', 'ascii');
  }

  buildAuthResponse(success) {
    return success ? Buffer.from('LOAD', 'ascii') : null;
  }

  buildLocationAck() {
    return Buffer.from('ON', 'ascii');
  }

  buildHeartbeatResponse() {
    return Buffer.from('ON', 'ascii');
  }
}

/**
 * Parser genérico para protocolos desconhecidos
 */
class GenericParser {
  parse(buffer) {
    // Parser genérico - tenta extrair informações básicas
    const hex = buffer.toString("hex");
    const ascii = buffer.toString("ascii").replace(/[^\x20-\x7E]/g, ".");

    return {
      success: true,
      data: {
        type: "unknown",
        hex: hex,
        ascii: ascii,
        length: buffer.length,
      },
      bytesProcessed: buffer.length,
    };
  }

  buildCommand(command, parameters) {
    // Comando genérico simples
    return Buffer.from(command, "ascii");
  }

  buildAuthResponse(success) {
    return Buffer.from("OK", "ascii");
  }

  buildLoginResponse(success) {
    return Buffer.from("OK", "ascii");
  }

  buildLocationAck(sequence) {
    return Buffer.from("ACK", "ascii");
  }

  buildHeartbeatResponse() {
    return Buffer.from("PONG", "ascii");
  }
}

module.exports = { ProtocolParser };
