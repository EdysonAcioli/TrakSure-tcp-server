const amqplib = require("amqplib");
const net = require("net");

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://traksure:traksure_pass@rabbitmq:5672";
const QUEUE = "device_commands";

async function run() {
  const conn = await amqplib.connect(RABBITMQ_URL);
  const ch = await conn.createChannel();
  await ch.assertQueue(QUEUE, { durable: true });
  console.log("Listening queue:", QUEUE);

  ch.consume(QUEUE, async (msg) => {
    if (!msg) return;
    let data;
    try {
      data = JSON.parse(msg.content.toString());
    } catch (err) {
      console.error("invalid message", err);
      ch.ack(msg);
      return;
    }

    console.log("Received command:", data);

    const { id, device_id, command_type, payload } = data;
    const host = payload && (payload.targetHost || payload.host);
    const port = payload && (payload.targetPort || payload.port);
    const raw = payload && (payload.rawCommand || JSON.stringify(payload));

    if (!host || !port) {
      console.warn("No target host/port in payload — ack and skip", { id, device_id });
      ch.ack(msg);
      return;
    }

    const socket = new net.Socket();
    let sent = false;
    const timeout = setTimeout(() => {
      if (!sent) {
        console.warn("Send timeout, closing socket", host, port);
        socket.destroy();
      }
    }, 5000);

    socket.connect(port, host, () => {
      try {
        socket.write(String(raw));
        sent = true;
        console.log(`Sent to ${host}:${port} ->`, raw);
        ch.ack(msg);
      } catch (err) {
        console.error("write error:", err);
        ch.nack(msg, false, true);
      } finally {
        clearTimeout(timeout);
        socket.end();
      }
    });

    socket.on("error", (err) => {
      console.error("socket error:", err);
      ch.nack(msg, false, true);
      clearTimeout(timeout);
    });

  }, { noAck: false });
}

run().catch((err) => {
  console.error("consumer error:", err);
  process.exit(1);
});