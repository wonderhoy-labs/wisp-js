import assert from "node:assert/strict";
import net from "node:net";
import { after, test } from "node:test";

import { NodeTCPSocket } from "../src/server/net.mjs";

const MIB = 1024 * 1024;
const servers = [];

after(() => {
  for (let server of servers) server.close();
});

//a destination that gives each connection to the handler
async function destination(handler) {
  let server = net.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

//sends the given number of bytes as fast as the socket will take them, then closes
function send_all(socket, total, on_done = () => {}) {
  let chunk = Buffer.alloc(64 * 1024, 7);
  let left = total;
  socket.on("error", () => {});
  let pump = () => {
    while (left > 0) {
      let size = Math.min(left, chunk.length);
      left -= size;
      if (!socket.write(chunk.subarray(0, size))) {
        socket.once("drain", pump);
        return;
      }
    }
    socket.end(on_done);
  };
  pump();
}

async function connect(port) {
  let socket = new NodeTCPSocket("127.0.0.1", port);
  await socket.connect("127.0.0.1");
  return socket;
}

async function read_all(socket) {
  let total = 0;
  while (true) {
    let data = await socket.recv();
    if (data == null) return total;
    total += data.length;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("delivers everything sent before the destination closed", async () => {
  let sent = 2 * MIB;
  let port = await destination((peer) => send_all(peer, sent));
  let socket = await connect(port);

  //long enough for all of it to arrive and the connection to close, with nothing read yet
  await sleep(300);
  assert.equal(await read_all(socket), sent);
});

test("delivers a large transfer read more slowly than it arrives", async () => {
  let sent = 32 * MIB;
  let port = await destination((peer) => send_all(peer, sent));
  let socket = await connect(port);

  let total = 0;
  let reads = 0;
  while (true) {
    let data = await socket.recv();
    if (data == null) break;
    total += data.length;
    if (++reads % 32 === 0) await sleep(1);
  }
  assert.equal(total, sent);
});

test("stops reading from the destination when nothing is taking the data", async () => {
  let finished = false;
  let port = await destination((peer) => send_all(peer, 128 * MIB, () => (finished = true)));
  let socket = await connect(port);

  await sleep(500);
  assert.equal(finished, false, "the destination should still be held up");
  let held = socket.data_queue.size + socket.data_queue.put_callbacks.length;
  assert.ok(held <= socket.recv_buffer_size, `${held} chunks held in memory`);

  await socket.close();
});

test("starts reading again once there is room", async () => {
  let sent = 16 * MIB;
  let port = await destination((peer) => send_all(peer, sent));
  let socket = await connect(port);

  await sleep(200);
  assert.equal(await read_all(socket), sent);
});

test("closing releases a connection that was held up", async () => {
  let closed = new Promise((resolve) => {
    destination((peer) => {
      peer.on("close", resolve);
      send_all(peer, 128 * MIB);
    }).then(async (port) => {
      let socket = await connect(port);
      await sleep(200);
      await socket.close();
      //what's left is gone, because nobody is going to read it
      assert.equal(await socket.recv(), undefined);
    });
  });
  await closed;
});

test("still sends to the destination what was written before closing", async () => {
  let received = [];
  let done = new Promise((resolve) => {
    destination((peer) => {
      peer.on("data", (data) => received.push(data));
      peer.on("end", () => {
        peer.end();
        resolve();
      });
    }).then(async (port) => {
      let socket = await connect(port);
      await socket.send(Buffer.from("last words"));
      await socket.close();
    });
  });
  await done;
  assert.equal(Buffer.concat(received).toString(), "last words");
});

test("reading after the destination has gone reports the end, not an error", async () => {
  let port = await destination((peer) => peer.end());
  let socket = await connect(port);
  await sleep(100);
  assert.equal(await socket.recv(), undefined);
  assert.equal(await socket.recv(), undefined);
});
