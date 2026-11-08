import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { Server } from "socket.io";
import { GameRoom, type GameRoomSnapshot } from "./game.ts";
import type { Ack, StatePayload } from "./shared.ts";

interface SocketIdentity {
  pin: string;
  playerId: string;
}

interface RoomEntry {
  pin: string;
  token: string;
  state: StatePayload;
}

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
const port = Number(process.env.PORT ?? 3000);
const dataDirectory = process.env.DATA_DIR ?? join(process.cwd(), "data");

function getLanUrl(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find((item) => item.family === "IPv4" && !item.internal);
    if (address) return `http://${address.address}:${port}`;
  }
  return `http://localhost:${port}`;
}

function getPublicUrl(): string | null {
  const fromEnv = process.env.PUBLIC_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const publicUrlFile = join(dataDirectory, "public-url.txt");
  if (!existsSync(publicUrlFile)) return null;
  const fromFile = readFileSync(publicUrlFile, "utf8").trim().replace(/\/$/, "");
  return fromFile || null;
}

function getJoinBaseUrl(): string {
  return getPublicUrl() ?? getLanUrl();
}

const distPath = join(process.cwd(), "dist");
if (existsSync(distPath)) {
  await app.register(fastifyStatic, { root: distPath });
  app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
}

app.get("/api/health", async () => ({ ok: true }));
app.get("/api/config", async () => ({
  joinBaseUrl: getJoinBaseUrl(),
  lanUrl: getLanUrl(),
  publicUrl: getPublicUrl()
}));

const io = new Server(app.server, {
  cors: { origin: true },
  transports: ["websocket", "polling"]
});
const rooms = new Map<string, GameRoom>();
mkdirSync(dataDirectory, { recursive: true });
const database = new DatabaseSync(join(dataDirectory, "rooms.sqlite"));
database.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    pin TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
for (const row of database.prepare("SELECT snapshot FROM rooms").all() as Array<{
  snapshot: string;
}>) {
  try {
    const snapshot = JSON.parse(row.snapshot) as GameRoomSnapshot;
    rooms.set(snapshot.pin, GameRoom.fromSnapshot(snapshot));
  } catch (error) {
    app.log.error(error, "Unable to restore room snapshot");
  }
}

function persistRoom(room: GameRoom): void {
  try {
    database
      .prepare(`
        INSERT INTO rooms (pin, snapshot, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(pin) DO UPDATE SET
          snapshot = excluded.snapshot,
          updated_at = excluded.updated_at
      `)
      .run(room.pin, JSON.stringify(room.snapshot()), Date.now());
  } catch (error) {
    app.log.error(error, `Unable to persist room ${room.pin}`);
  }
}

function deleteRoomSnapshot(pin: string): void {
  try {
    database.prepare("DELETE FROM rooms WHERE pin = ?").run(pin);
  } catch (error) {
    app.log.error(error, `Unable to delete room ${pin}`);
  }
}

function createUniqueRoom(): GameRoom {
  let room = new GameRoom();
  while (rooms.has(room.pin)) room = new GameRoom();
  rooms.set(room.pin, room);
  return room;
}

function replyError<T>(callback: ((ack: Ack<T>) => void) | undefined, error: unknown): void {
  callback?.({ ok: false, error: error instanceof Error ? error.message : "操作失败" });
}

io.on("connection", (socket) => {
  const identity = (): SocketIdentity => {
    const data = socket.data.identity as SocketIdentity | undefined;
    if (!data) throw new Error("请先加入房间");
    return data;
  };

  const currentRoom = (): GameRoom => {
    const { pin } = identity();
    const room = rooms.get(pin);
    if (!room) throw new Error("房间不存在");
    return room;
  };

  const emitRoom = (room: GameRoom): void => {
    persistRoom(room);
    for (const player of room.players) {
      if (!player.socketId) continue;
      const targetSocket = io.sockets.sockets.get(player.socketId);
      if (!targetSocket) continue;
      const payload: StatePayload = {
        public: room.publicState(),
        private: room.privateState(player.id)
      };
      targetSocket.emit("state", payload);
    }
  };

  const mutate = (
    action: (room: GameRoom, playerId: string) => void,
    callback?: (ack: Ack) => void
  ): void => {
    try {
      const room = currentRoom();
      action(room, identity().playerId);
      emitRoom(room);
      callback?.({ ok: true });
    } catch (error) {
      replyError(callback, error);
    }
  };

  socket.on(
    "room:create",
    (input: { nickname: string }, callback: (ack: Ack<RoomEntry>) => void) => {
      try {
        const room = createUniqueRoom();
        const player = room.addPlayer(input.nickname, socket.id);
        socket.data.identity = { pin: room.pin, playerId: player.id };
        socket.join(room.pin);
        callback({
          ok: true,
          data: {
            pin: room.pin,
            token: player.token,
            state: { public: room.publicState(), private: room.privateState(player.id) }
          }
        });
        emitRoom(room);
      } catch (error) {
        replyError(callback, error);
      }
    }
  );

  socket.on(
    "room:join",
    (
      input: { pin: string; nickname: string },
      callback: (ack: Ack<RoomEntry>) => void
    ) => {
      try {
        const pin = input.pin.replace(/\D/g, "");
        const room = rooms.get(pin);
        if (!room) throw new Error("房间不存在");
        const player = room.addPlayer(input.nickname, socket.id);
        socket.data.identity = { pin, playerId: player.id };
        socket.join(pin);
        callback({
          ok: true,
          data: {
            pin,
            token: player.token,
            state: { public: room.publicState(), private: room.privateState(player.id) }
          }
        });
        emitRoom(room);
      } catch (error) {
        replyError(callback, error);
      }
    }
  );

  socket.on(
    "room:resume",
    (
      input: { pin: string; token: string },
      callback: (ack: Ack<RoomEntry>) => void
    ) => {
      try {
        const room = rooms.get(input.pin);
        if (!room) throw new Error("房间已经失效");
        const player = room.reconnect(input.token, socket.id);
        socket.data.identity = { pin: room.pin, playerId: player.id };
        socket.join(room.pin);
        callback({
          ok: true,
          data: {
            pin: room.pin,
            token: player.token,
            state: { public: room.publicState(), private: room.privateState(player.id) }
          }
        });
        emitRoom(room);
      } catch (error) {
        replyError(callback, error);
      }
    }
  );

  socket.on("room:reorder", (input: { playerIds: string[] }, callback: (ack: Ack) => void) =>
    mutate((room, playerId) => room.reorder(playerId, input.playerIds), callback)
  );
  socket.on("room:kick", (input: { targetId: string }, callback: (ack: Ack) => void) => {
    try {
      const room = currentRoom();
      const requesterId = identity().playerId;
      const target = room.players.find((player) => player.id === input.targetId);
      if (!target) throw new Error("玩家不存在");
      room.removePlayer(requesterId, input.targetId);
      if (target.socketId) {
        const targetSocket = io.sockets.sockets.get(target.socketId);
        if (targetSocket) {
          targetSocket.emit("room:kicked", { message: "你已被房主移出房间" });
          targetSocket.leave(room.pin);
          targetSocket.data.identity = undefined;
        }
      }
      emitRoom(room);
      callback({ ok: true });
    } catch (error) {
      replyError(callback, error);
    }
  });
  socket.on("room:dissolve", (_input: unknown, callback: (ack: Ack) => void) => {
    try {
      const room = currentRoom();
      const requesterId = identity().playerId;
      const host = room.players.find((player) => player.id === requesterId);
      if (!host?.isHost) throw new Error("只有房主可以解散房间");
      for (const player of room.players) {
        if (!player.socketId) continue;
        const targetSocket = io.sockets.sockets.get(player.socketId);
        if (!targetSocket) continue;
        targetSocket.emit("room:dissolved", { message: "房主已解散房间" });
        targetSocket.leave(room.pin);
        targetSocket.data.identity = undefined;
      }
      rooms.delete(room.pin);
      deleteRoomSnapshot(room.pin);
      callback({ ok: true });
    } catch (error) {
      replyError(callback, error);
    }
  });
  socket.on("game:start", (_input: unknown, callback: (ack: Ack) => void) =>
    mutate((room, playerId) => room.start(playerId), callback)
  );
  socket.on(
    "game:initialCoin",
    (input: { targetId: string }, callback: (ack: Ack) => void) =>
      mutate((room, playerId) => room.chooseInitialCoin(playerId, input.targetId), callback)
  );
  socket.on(
    "game:crystal",
    (input: { targetIds?: string[] }, callback: (ack: Ack) => void) =>
      mutate((room, playerId) => room.activateCrystal(playerId, input.targetIds), callback)
  );
  socket.on("game:play", (input: { cardId: string | null }, callback: (ack: Ack) => void) =>
    mutate((room, playerId) => room.playCard(playerId, input.cardId), callback)
  );
  socket.on(
    "game:crystal10",
    (
      input: { targetId?: string; replacementCardId?: string },
      callback: (ack: Ack) => void
    ) =>
      mutate(
        (room, playerId) =>
          room.handleCrystal10(playerId, input.targetId, input.replacementCardId),
        callback
      )
  );
  socket.on(
    "game:nextCoin",
    (input: { targetId: string }, callback: (ack: Ack) => void) =>
      mutate((room, playerId) => room.chooseNextCoin(playerId, input.targetId), callback)
  );
  socket.on(
    "game:endVote",
    (input: { action?: "propose" | "agree" | "reject" }, callback: (ack: Ack) => void) =>
      mutate((room, playerId) => {
        if (input.action === "agree" || input.action === "reject") {
          room.castEndVote(playerId, input.action === "agree");
          return;
        }
        room.proposeEnd(playerId);
      }, callback)
  );
  socket.on("game:new", (_input: unknown, callback: (ack: Ack) => void) =>
    mutate((room, playerId) => room.newGame(playerId), callback)
  );

  socket.on("disconnect", () => {
    try {
      const room = currentRoom();
      room.disconnect(socket.id);
      emitRoom(room);
    } catch {
      // The socket may disconnect before joining a room.
    }
  });
});

await app.listen({ port, host: "0.0.0.0" });
