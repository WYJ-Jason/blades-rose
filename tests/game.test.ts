import { describe, expect, it } from "vitest";
import { createGameConfig, GameRoom } from "../src/game.ts";

function createRoom(count = 5): { room: GameRoom; hostId: string } {
  const room = new GameRoom("123456", () => 0.42);
  for (let index = 1; index <= count; index += 1) {
    room.addPlayer(`玩家${index}`);
  }
  return { room, hostId: room.publicState().players[0].id };
}

function playWholeRound(
  room: GameRoom,
  selector: (playerId: string) => string | null
): void {
  while (room.publicState().stage === "choosing") {
    const playerId = room.publicState().activePlayerId!;
    room.playCard(playerId, selector(playerId));
  }
}

describe("game configuration", () => {
  it("creates the correct role and victory counts for every supported player count", () => {
    for (let count = 5; count <= 10; count += 1) {
      const config = createGameConfig(count);
      expect(config.roles).toHaveLength(count);
      expect(config.sacrificeTarget).toBe(count - 3);
      expect(config.deathTarget).toBe(count - 2);
      expect(config.maxRounds).toBe(count);
      expect(config.roles.filter((role) => role === "whiteRose")).toHaveLength(1);
      expect(config.roles.filter((role) => role === "doubleBlade")).toHaveLength(1);
      expect(config.roles.filter((role) => role === "darkBlade")).toHaveLength(1);
    }
  });

  it("rejects unsupported player counts", () => {
    expect(() => createGameConfig(4)).toThrow();
    expect(() => createGameConfig(11)).toThrow();
  });
});

describe("room setup and private information", () => {
  it("allows duplicate nicknames because seat numbers identify players", () => {
    const room = new GameRoom("123456");
    room.addPlayer("玩家");
    room.addPlayer("玩家");
    expect(room.publicState().players.map((player) => player.seat)).toEqual([1, 2]);
  });

  it("lets the host remove another player and then reassign seats", () => {
    const { room, hostId } = createRoom(3);
    const targetId = room.publicState().players[1].id;
    room.removePlayer(hostId, targetId);
    expect(room.publicState().players).toHaveLength(2);
    expect(room.publicState().players.map((player) => player.seat)).toEqual([1, 2]);
    expect(() => room.removePlayer(hostId, hostId)).toThrow("房主不能移出自己");
  });

  it("deals unique identities, crystals, double-blade hand and sight lists", () => {
    const { room, hostId } = createRoom(8);
    room.start(hostId);
    const states = room.publicState().players.map((player) => room.privateState(player.id));
    expect(new Set(states.map((state) => state.crystal)).size).toBe(8);
    expect(room.publicState().players.every((player) => player.role === undefined)).toBe(true);

    const doubleBlade = states.find((state) => state.role === "doubleBlade")!;
    expect(doubleBlade.hand.filter((card) => card.type === "doubleBlade")).toHaveLength(2);
    expect(doubleBlade.hand.some((card) => card.type === "ghost")).toBe(false);

    const darkBlade = states.find((state) => state.role === "darkBlade")!;
    expect(darkBlade.sightPlayers).toHaveLength(0);
    expect(doubleBlade.sightPlayers.length).toBeGreaterThan(0);
    expect(doubleBlade.sightPlayers.some((player) => player.id === darkBlade.playerId)).toBe(false);
  });

  it("keeps the host crystal unused when the host assigns the first coin to another player", () => {
    const { room, hostId } = createRoom();
    room.start(hostId);
    const second = room.publicState().players[1];
    room.chooseInitialCoin(hostId, second.id);
    expect(room.privateState(hostId).crystalUsed).toBe(false);
    expect(room.publicState().coinHolderId).toBe(second.id);
    expect(room.publicState().currentCrystal?.ownerId).toBe(second.id);
    expect(room.publicState().players.find((player) => player.id === second.id)?.revealedCrystal).toBe(
      room.privateState(second.id).crystal
    );
  });

  it("restores private game state from a persisted snapshot", () => {
    const { room, hostId } = createRoom();
    room.start(hostId);
    const restored = GameRoom.fromSnapshot(room.snapshot(), () => 0.42);
    expect(restored.publicState().stage).toBe("initialCoin");
    expect(restored.publicState().players.every((player) => !player.online)).toBe(true);
    for (const player of room.publicState().players) {
      expect(restored.privateState(player.id).role).toBe(room.privateState(player.id).role);
      expect(restored.privateState(player.id).crystal).toBe(room.privateState(player.id).crystal);
      expect(restored.privateState(player.id).hand).toEqual(room.privateState(player.id).hand);
    }
  });
});

describe("turn order and crystal constraints", () => {
  it("forces a player to act only on their normal turn", () => {
    const { room, hostId } = createRoom();
    room.start(hostId);
    const players = room.publicState().players;
    (room as unknown as { players: Array<{ id: string; crystal: number }> }).players.find(
      (player) => player.id === hostId
    )!.crystal = 1;
    room.chooseInitialCoin(hostId, hostId);
    expect(room.publicState().stage).toBe("crystal");
    expect(room.publicState().currentCrystal).toMatchObject({
      number: 1,
      ownerId: hostId
    });
    expect(room.publicState().currentCrystal?.description).toBeTruthy();
    expect(room.publicState().players.find((player) => player.id === hostId)?.revealedCrystal).toBe(1);
    room.activateCrystal(hostId, [players[1].id]);

    expect(room.publicState().activePlayerId).toBe(hostId);
    room.playCard(hostId, null);
    expect(room.publicState().activePlayerId).toBe(players[1].id);
    expect(() => room.playCard(players[1].id, null)).toThrow("必须出牌");
  });

  it("requires a locked neighboring card to be played and forbids skipping", () => {
    const { room, hostId } = createRoom();
    room.start(hostId);
    const players = room.publicState().players;
    (room as unknown as { players: Array<{ id: string; crystal: number }> }).players.find(
      (player) => player.id === hostId
    )!.crystal = 3;
    room.chooseInitialCoin(hostId, hostId);
    const neighbor = players[1];
    const locked = room.privateState(neighbor.id).lockedCardId;
    expect(locked).toBeTruthy();
    expect(room.privateState(neighbor.id).mustPlay).toBe(true);
    room.playCard(hostId, null);
    expect(() => room.playCard(neighbor.id, null)).toThrow("必须出牌");
    room.playCard(neighbor.id, locked!);
    expect(room.publicState().players.find((player) => player.id === neighbor.id)?.action).toBe(
      "played"
    );
  });

  it("reveals card owners without shuffling for crystal 2", () => {
    const { room, hostId } = createRoom();
    room.start(hostId);
    (room as unknown as { players: Array<{ id: string; crystal: number }> }).players.find(
      (player) => player.id === hostId
    )!.crystal = 2;
    room.chooseInitialCoin(hostId, hostId);
    expect(room.publicState().currentCrystal?.number).toBe(2);
    expect(room.publicState().stage).toBe("choosing");
    playWholeRound(room, (playerId) => {
      const believer = room
        .privateState(playerId)
        .hand.find((card) => card.zone === "hand" && card.type === "believer");
      return believer?.id ?? null;
    });
    expect(room.publicState().roundReveal).toHaveLength(5);
    expect(room.publicState().roundReveal.every((card) => Boolean(card.ownerId))).toBe(true);
    expect(room.publicState().board.sacrifice).toHaveLength(5);
    expect(room.publicState().roundHistory).toHaveLength(1);
    expect(room.publicState().roundHistory[0]).toMatchObject({
      round: 1,
      coinHolderId: hostId,
      crystal: { number: 2 }
    });
    expect(room.publicState().roundHistory[0].cards).toHaveLength(5);
    expect(room.publicState().roundHistory[0].plays.filter((play) => play.action === "played")).toHaveLength(5);
  });

  it("makes the first bound player make up a card if they skipped and the second played", () => {
    const { room, hostId } = createRoom();
    room.start(hostId);
    const players = room.publicState().players;
    (room as unknown as { players: Array<{ id: string; crystal: number }> }).players.find(
      (player) => player.id === hostId
    )!.crystal = 5;
    room.chooseInitialCoin(hostId, hostId);
    room.activateCrystal(hostId, [hostId, players[1].id]);
    const secondCard = room
      .privateState(players[1].id)
      .hand.find((card) => card.zone === "hand")!.id;
    while (room.publicState().stage === "choosing") {
      const playerId = room.publicState().activePlayerId!;
      if (playerId === hostId && room.privateState(hostId).mustPlay) break;
      if (playerId === players[1].id) room.playCard(playerId, secondCard);
      else room.playCard(playerId, null);
    }
    expect(room.privateState(hostId).mustPlay).toBe(true);
    expect(() => room.playCard(hostId, null)).toThrow("必须出牌");
    const makeup = room.privateState(hostId).hand.find((card) => card.zone === "hand")!.id;
    room.playCard(hostId, makeup);
    expect(["crystal10", "nextCoin", "ended"]).toContain(room.publicState().stage);
  });

  it("lets crystal 10 replace the coin holder's own card", () => {
    const { room, hostId } = createRoom();
    room.start(hostId);
    (room as unknown as { players: Array<{ id: string; crystal: number }> }).players.find(
      (player) => player.id === hostId
    )!.crystal = 10;
    room.chooseInitialCoin(hostId, hostId);
    playWholeRound(room, (playerId) => {
      const believer = room
        .privateState(playerId)
        .hand.find((card) => card.zone === "hand" && card.type === "believer");
      return believer?.id ?? null;
    });
    expect(room.publicState().stage).toBe("crystal10");
    expect(room.privateState(hostId).eligibleTargets).toContain(hostId);
  });
});

describe("ending a game", () => {
  it("ends immediately when white rose and a blade are revealed together", () => {
    const { room, hostId } = createRoom();
    room.start(hostId);
    (room as unknown as { players: Array<{ id: string; crystal: number }> }).players.find(
      (player) => player.id === hostId
    )!.crystal = 2;
    room.chooseInitialCoin(hostId, hostId);
    playWholeRound(room, (playerId) => {
      const state = room.privateState(playerId);
      const lethal = state.hand.find(
        (card) =>
          card.zone === "hand" &&
          ["whiteRose", "doubleBlade", "giantBlade", "darkBlade"].includes(card.type)
      );
      return lethal?.id ?? null;
    });
    expect(room.publicState().stage).toBe("ended");
    expect(room.publicState().winner).toBe("blade");
    expect(room.publicState().players.some((player) => player.role !== undefined)).toBe(true);
  });

  it("awards the blade faction the win when any bud remains in hand after the last round", () => {
    const { room, hostId } = createRoom();
    room.start(hostId);
    const internals = room as unknown as {
      players: Array<{ crystalUsed: boolean; cards: Array<{ type: string; zone: string }> }>;
      revealRound: () => void;
    };
    expect(
      internals.players.some((player) =>
        player.cards.some((card) => card.zone === "hand" && (card.type === "believer" || card.type === "bishop"))
      )
    ).toBe(true);
    internals.players.forEach((player) => {
      player.crystalUsed = true;
    });
    internals.revealRound();
    expect(room.publicState().stage).toBe("ended");
    expect(room.publicState().winner).toBe("blade");
    expect(room.publicState().message).toContain("花苞");
  });

  it("still awards rose the win at game end if no buds or white rose remain in hand", () => {
    const { room, hostId } = createRoom();
    room.start(hostId);
    const internals = room as unknown as {
      players: Array<{ crystalUsed: boolean; cards: Array<{ type: string; zone: string }> }>;
      revealRound: () => void;
    };
    internals.players.forEach((player) => {
      player.crystalUsed = true;
      player.cards.forEach((card) => {
        if (card.type === "believer" || card.type === "bishop" || card.type === "whiteRose") {
          card.zone = "removed";
        }
      });
    });
    internals.revealRound();
    expect(room.publicState().winner).toBe("rose");
  });

  it("requires a strict majority to abort and preserves the room for a new game", () => {
    const { room, hostId } = createRoom(6);
    room.start(hostId);
    const players = room.publicState().players;
    room.proposeEnd(players[0].id);
    room.castEndVote(players[1].id, true);
    room.castEndVote(players[2].id, true);
    expect(room.publicState().stage).not.toBe("ended");
    expect(room.publicState().endProposalActive).toBe(true);
    room.castEndVote(players[3].id, true);
    expect(room.publicState().winner).toBe("aborted");
    room.newGame(hostId);
    expect(room.publicState().stage).toBe("lobby");
    expect(room.publicState().players).toHaveLength(6);
  });
});
