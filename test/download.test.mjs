import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { afterEach, before, test } from "node:test";

import { ClientConnection } from "../src/client/connection.mjs";
import { set_level, NONE } from "../src/logging.mjs";
import { routeRequest } from "../src/server/http.mjs";
import { options } from "../src/server/options.mjs";

const MIB = 1024 * 1024;
let cleanups = [];

before(() => {
  set_level(NONE);
  options.allow_loopback_ips = true;
});

afterEach(() => {
  for (let cleanup of cleanups) cleanup();
  cleanups = [];
});

//a destination that sends this much as fast as it can, then closes
async function start_destination(sent) {
  let target = net.createServer((peer) => {
    peer.on("error", () => {});
    let chunk = Buffer.alloc(64 * 1024, 7);
    let left = sent;
    let pump = () => {
      while (left > 0) {
        left -= chunk.length;
        if (!peer.write(chunk)) {
          peer.once("drain", pump);
          return;
        }
      }
      peer.end();
    };
    pump();
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => target.close());
  return target.address().port;
}

async function start_connection() {
  let server = http.createServer();
  server.on("upgrade", (request, socket, head) => routeRequest(request, socket, head));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.close();
    server.closeAllConnections();
  });

  let connection = new ClientConnection(`ws://127.0.0.1:${server.address().port}/`);
  await new Promise((resolve) => (connection.onopen = resolve));
  cleanups.push(() => connection.close());
  return connection;
}

//the client falls behind, so the server has to hold back while the destination finishes
function fall_behind(connection, ms) {
  connection.ws.pause();
  setTimeout(() => connection.ws.resume(), ms);
}

test("a slow client gets all of a download from a destination that closes straight away", async () => {
  let sent = 128 * MIB;
  let port = await start_destination(sent);
  let connection = await start_connection();

  let received = 0;
  let reason = await new Promise((resolve) => {
    let stream = connection.create_stream("127.0.0.1", port);
    stream.onmessage = (data) => (received += data.length);
    stream.onclose = resolve;
    fall_behind(connection, 500);
  });

  assert.equal(received, sent);
  assert.equal(reason, 0x02);
});

test("a client still sending after the destination has gone gets the rest, and then the close", async () => {
  let sent = 32 * MIB;
  let port = await start_destination(sent);
  let connection = await start_connection();

  let received = 0;
  let reason = await new Promise((resolve) => {
    let stream = connection.create_stream("127.0.0.1", port);
    stream.onmessage = (data) => (received += data.length);
    let sending = setInterval(() => stream.send(new Uint8Array(1024)), 5);
    stream.onclose = (close_reason) => {
      clearInterval(sending);
      resolve(close_reason);
    };
    fall_behind(connection, 500);
  });

  assert.equal(received, sent);
  assert.equal(reason, 0x02);
});

test("several slow downloads at once all arrive whole", async () => {
  let sent = 16 * MIB;
  let port = await start_destination(sent);
  let connection = await start_connection();

  let downloads = Array.from({ length: 8 }, () => new Promise((resolve) => {
    let received = 0;
    let stream = connection.create_stream("127.0.0.1", port);
    stream.onmessage = (data) => (received += data.length);
    stream.onclose = () => resolve(received);
  }));
  fall_behind(connection, 500);

  let totals = await Promise.all(downloads);
  assert.deepEqual(totals, Array(8).fill(sent));
});
