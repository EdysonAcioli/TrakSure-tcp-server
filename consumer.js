const amqplib = require("amqplib");
const net = require("net");
const dns = require("dns");

const RABBITMQ_URL =
  process.env.RABBITMQ_URL || "amqp://traksure:traksure_pass@localhost:5672";
const QUEUE = process.env.QUEUE_NAME || "device_commands";
const QUEUE_TTL = process.env.QUEUE_TTL
  ? Number(process.env.QUEUE_TTL)
  : undefined; // milliseconds

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeAssertQueue(ch, queue, opts, attempts = 5) {
  let backoff = 200;
  for (let i = 0; i < attempts; i++) {
    try {
      await ch.assertQueue(queue, opts);
      return;
    } catch (err) {
      const msg = String(err && err.message ? err.message : err).toLowerCase();
      // if PRECONDITION or NOT_FOUND, wait and retry — likely a race or transient channel state
      if (msg.includes('precondition') || msg.includes('not-found') || msg.includes('not found') || msg.includes('404') || msg.includes('channel closed')) {
        console.warn(`assertQueue attempt ${i + 1} failed for ${queue}:`, msg);
        await delay(backoff);
        backoff = Math.min(backoff * 2, 5000);
        continue;
      }
      throw err;
    }
  }
  // final attempt to bubble up error
  await ch.assertQueue(queue, opts);
}

async function runOnce() {
  const conn = await amqplib.connect(RABBITMQ_URL);
  conn.on("error", (err) => console.error("AMQP connection error:", err));
  conn.on("close", () => console.warn("AMQP connection closed"));

  const ch = await conn.createChannel();
  const assertOptions = { durable: true };
  if (QUEUE_TTL !== undefined)
    assertOptions.arguments = { "x-message-ttl": QUEUE_TTL };

  // Avoid PRECONDITION-FAILED when an existing queue has different arguments
  try {
    await ch.checkQueue(QUEUE);
    console.log(`Queue already exists, skipping declare: ${QUEUE}`);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (msg.includes("NOT_FOUND") || msg.includes("not found") || msg.includes("404")) {
      await safeAssertQueue(ch, QUEUE, assertOptions);
    } else {
      console.warn(`Unexpected error checking queue ${QUEUE}:`, err);
      await safeAssertQueue(ch, QUEUE, assertOptions);
    }
  }

  console.log(`Listening queue: ${QUEUE} (ttl=${QUEUE_TTL || "none"})`);

  await ch.consume(
    QUEUE,
    async (msg) => {
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
        console.warn("No target host/port in payload — ack and skip", {
          id,
          device_id,
        });
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

      // resolve hostname first to avoid getaddrinfo EAI_AGAIN flooding
      dns.lookup(host, (dnsErr, address) => {
        if (dnsErr) {
          console.error(
            "DNS lookup failed for host",
            host,
            dnsErr && dnsErr.code ? dnsErr.code : dnsErr
          );
          ch.ack(msg);
          clearTimeout(timeout);
          return;
        }

        socket.connect(port, address, () => {
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
          console.error("socket error to %s:%s ->", host, port, err);
          ch.nack(msg, false, true);
          clearTimeout(timeout);
        });
      });
    },
    { noAck: false }
  );

  // return a promise that resolves when connection closes/errors so caller can reconnect
  return new Promise((resolve, reject) => {
    conn.once("close", () => resolve());
    conn.once("error", (err) => reject(err));
  });
}

async function start() {
  let backoff = 1000;
  while (true) {
    try {
      await runOnce();
      // natural close, reset backoff
      backoff = 1000;
      console.log("AMQP connection closed, will reconnect shortly");
    } catch (err) {
      console.error("consumer error:", err && err.stack ? err.stack : err);
    }

    // wait before reconnecting
    console.log(`Reconnecting to AMQP in ${backoff}ms`);
    await delay(backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
}

start().catch((err) => {
  console.error("Fatal consumer error:", err);
});
