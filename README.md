# TrakSure TCP Server

Servidor TCP completo para comunicação com dispositivos GPS. Suporta múltiplos protocolos, recebe dados de localização em tempo real e envia comandos remotos aos trackers.

## 🚀 Funcionalidades

- **Múltiplos Protocolos**: GT06, TK103, H02 e protocolo genérico
- **Comunicação Bidirecional**: Recebe dados e envia comandos
- **Sistema de Autenticação**: Validação de IMEI no banco de dados
- **Processamento em Tempo Real**: Integração com RabbitMQ e PostgreSQL
- **Gerenciamento de Dispositivos**: Status online/offline, heartbeats
- **Sistema de Logs**: Logs detalhados com rotação automática
- **Monitoramento**: Estatísticas e métricas em tempo real

## 📁 Estrutura do Projeto

```
TrakSure-tcp-server/
├── index.js                   # Arquivo principal
├── tcp-server.js              # Classe principal do servidor TCP
├── protocol-parser.js         # Parser de protocolos GPS
├── device-manager.js          # Gerenciador de dispositivos
├── consumer.js                # Consumer de comandos (legado)
├── services/
│   ├── rabbitmq.service.js   # Serviço RabbitMQ
│   └── database.service.js   # Serviço PostgreSQL
├── utils/
│   └── logger.js             # Sistema de logging
├── logs/                     # Logs do sistema
├── package.json
├── ecosystem.config.js       # Configuração PM2
├── .env.example             # Exemplo de variáveis
└── README.md
```

## ⚙️ Configuração

### 1. Instalar Dependências

```bash
cd TrakSure-tcp-server
npm install
```

### 2. Configurar Variáveis de Ambiente

```bash
cp .env.example .env
nano .env
```

Edite as configurações:

```env
TCP_PORT=5000
TCP_HOST=0.0.0.0
DATABASE_URL=postgresql://traksure:traksure_pass@localhost:5432/traksure
RABBITMQ_URL=amqp://traksure:traksure_pass@localhost:5672
LOG_LEVEL=info
```

### 3. Verificar Dependências

Certifique-se que estão rodando:

- ✅ PostgreSQL + PostGIS (porta 5432)
- ✅ RabbitMQ (porta 5672)

## 🚀 Execução

### Desenvolvimento

```bash
npm run dev
```

### Produção com PM2

```bash
# Iniciar
pm2 start ecosystem.config.js

# Verificar status
pm2 status

# Ver logs
pm2 logs traksure-tcp-server

# Parar
pm2 stop traksure-tcp-server

# Reiniciar
pm2 restart traksure-tcp-server
```

### Produção Simples

```bash
npm start
```

## 📡 Protocolos Suportados

### GT06 (Protocolo mais comum)

- **Pacotes**: Login, Localização, Heartbeat, Alarmes
- **Comandos**: Localizar, Reiniciar, Parar/Religar Motor
- **Format**: Binário com start/stop bits

### TK103

- **Pacotes**: ASCII baseado em strings
- **Format**: `##,imei:359710045490084,A;`

### Protocolo Genérico

- **Fallback**: Para dispositivos não identificados
- **Log**: Dados em HEX e ASCII para análise

## 🔧 Uso da API

### Fluxo de Dados

1. **Dispositivo → TCP Server**: Dados de localização
2. **TCP Server → RabbitMQ**: Publicação em filas
3. **TCP Server → Database**: Persistência no PostGIS
4. **API → RabbitMQ**: Comandos para dispositivos
5. **TCP Server → Dispositivo**: Envio de comandos

### Comandos Disponíveis

```javascript
// Localizar dispositivo
{
  "imei": "359710045490084",
  "command": "locate",
  "parameters": {}
}

// Reiniciar dispositivo
{
  "imei": "359710045490084",
  "command": "reboot",
  "parameters": {}
}

// Parar motor
{
  "imei": "359710045490084",
  "command": "engine_stop",
  "parameters": {}
}
```

## 📊 Monitoramento

### Logs

```bash
# Ver logs em tempo real
tail -f logs/tcp-server-2023-12-19.log

# Logs por nível
grep "ERROR" logs/tcp-server-*.log
grep "WARN" logs/tcp-server-*.log
```

### Estatísticas

- Dispositivos conectados
- Mensagens processadas
- Comandos enviados
- Uso de memória

### RabbitMQ

- Acesse: http://localhost:15672
- User: traksure / Pass: traksure_pass

## 🔍 Debugging

### Verificar Conexões

```bash
# Ver portas abertas
netstat -tulpn | grep :5000

# Conexões TCP ativas
ss -tn | grep :5000
```

### Testar Conexão

```bash
# Conectar via telnet
telnet localhost 5000

# Enviar dados hex (exemplo GT06)
echo -ne '\x78\x78\x0d\x01\x03\x59\x71\x00\x45\x49\x00\x84\x50\x00\x0d\x0a' | nc localhost 5000
```

### Logs de Debug

```bash
# Ativar debug
export LOG_LEVEL=debug
npm start
```

## 🚨 Troubleshooting

### Problemas Comuns

1. **Porta em uso**

   ```bash
   sudo lsof -i :5000
   sudo kill -9 <PID>
   ```

2. **Banco não conecta**

   ```bash
   psql -h localhost -U traksure -d traksure
   ```

3. **RabbitMQ não conecta**

   ```bash
   docker compose logs rabbitmq
   ```

4. **Device não autentica**
   - Verificar se IMEI existe na tabela `devices`
   - Verificar status `active = true`

### Firewall (VPS)

```bash
# Liberar porta TCP
sudo ufw allow 5000/tcp

# Verificar regras
sudo ufw status
```

## 📈 Performance

### Configurações Recomendadas

- **RAM**: Mínimo 512MB por instância
- **CPU**: 1 core por 1000 dispositivos
- **Rede**: Baixa latência para GPS
- **Disco**: SSD para logs e banco

### Otimizações

- Use PM2 cluster mode para múltiplas instâncias
- Configure load balancer para alta disponibilidade
- Monitore uso de memória e CPU
- Implemente rate limiting se necessário

## 🔒 Segurança

- Validação de IMEI no banco
- Timeout de autenticação (30s)
- Rate limiting de conexões
- Logs de segurança detalhados
- Firewall configurado adequadamente

## 📝 Contribuição

1. Fork o projeto
2. Crie uma branch para sua feature
3. Commit suas mudanças
4. Push para a branch
5. Abra um Pull Request

## 📄 Licença

MIT License - veja LICENSE file para detalhes.
