import assert from "node:assert/strict";
import { test } from "node:test";

import { PasswordAuthExtension, parse_extensions, serialize_extensions } from "../src/extensions.mjs";
import { WispBuffer } from "../src/packet.mjs";

const client = (username, password) => new PasswordAuthExtension({ client_config: { username, password } });

test("the client's message follows the protocol", () => {
  //username length, username, and then the password fills the rest of the payload
  let bytes = client("ab", "xyz").payload.serialize().bytes;
  assert.deepEqual([...bytes], [2, 97, 98, 120, 121, 122]);
});

test("the whole extension has its id and length in front", () => {
  let bytes = client("ab", "xyz").serialize().bytes;
  assert.deepEqual([...bytes], [0x02, 6, 0, 0, 0, 2, 97, 98, 120, 121, 122]);
});

for (let [name, username, password] of [
  ["plain text", "hazel", "correct horse"],
  ["text outside ascii", "ハゼル", "pä55:wörd"],
  ["an empty password", "hazel", ""],
]) {
  test(`a server reads back ${name}`, () => {
    let message = serialize_extensions([client(username, password)]);
    let known = [new PasswordAuthExtension({ server_config: { required: 1 } })];
    let [parsed] = parse_extensions(new WispBuffer(message.bytes), known, "client");
    assert.equal(parsed.payload.username, username);
    assert.equal(parsed.payload.password, password);
  });
}

test("a username too long for its length field is refused", () => {
  assert.throws(() => client("x".repeat(256), "").payload.serialize(), RangeError);
});

test("the server's message is unchanged", () => {
  let server = new PasswordAuthExtension({ server_config: { required: 1 } });
  assert.deepEqual([...server.serialize().bytes], [0x02, 1, 0, 0, 0, 1]);
});
