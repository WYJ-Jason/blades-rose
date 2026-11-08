import { randomBytes, randomUUID } from "node:crypto";
import {
  type CardType,
  type CardZone,
  type Faction,
  type GameConfig,
  type GameStage,
  type PrivateState,
  type PublicCard,
  type PublicCrystal,
  type PublicState,
  type RoundHistoryEntry,
  type Role,
  CRYSTALS,
  factionForRole
} from "./shared.ts";

interface Card {
  id: string;
  type: CardType;
  ownerId: string;
  zone: CardZone;
}

interface Player {
  id: string;
  token: string;
  socketId?: string;
  nickname: string;
  seat: number;
  online: boolean;
  isHost: boolean;
  role?: Role;
  cards: Card[];
  crystal?: number;
  crystalUsed: boolean;
  privateMessage?: string;
  endVote: boolean;
  endVoteCast: boolean;
}

interface RoundModifiers {
  noShuffle: boolean;
  mustPlay: Set<string>;
  lockedCards: Map<string, string>;
  pair?: { first: string; second: string };
  pairMakeup: boolean;
  crystal10: boolean;
  replacementPlayerId?: string;
}

export interface GameRoomSnapshot {
  pin: string;
  players: Array<Omit<Player, "socketId">>;
  stage: GameStage;
  config: GameConfig | null;
  coinHolderId?: string;
  activePlayerId?: string;
  round: number;
  winner?: Faction | "aborted";
  message: string;
  roundReveal: PublicCard[];
  roundHistory?: RoundHistoryEntry[];
  centralGhostAvailable: boolean;
  order: string[];
  turnIndex: number;
  plays: Array<[string, string | null]>;
  modifiers: {
    noShuffle: boolean;
    mustPlay: string[];
    lockedCards: Array<[string, string]>;
    pair?: { first: string; second: string };
    pairMakeup: boolean;
    crystal10: boolean;
    replacementPlayerId?: string;
  };
  darkBladeVision: boolean;
  currentCrystal?: PublicCrystal;
  endProposalActive?: boolean;
  endVoteProposerId?: string;
}

const EMPTY_MODIFIERS = (): RoundModifiers => ({
  noShuffle: false,
  mustPlay: new Set(),
  lockedCards: new Map(),
  pairMakeup: false,
  crystal10: false
});

const SIGHT_ROLES = new Set<Role>(["whiteRose", "bishop", "doubleBlade", "giantBlade"]);
const BLADE_CARDS = new Set<CardType>(["doubleBlade", "giantBlade", "darkBlade"]);
const BUD_CARDS = new Set<CardType>(["believer", "bishop"]);
const TARGET_CRYSTALS = new Set([1, 5, 7, 11, 12]);

function shuffle<T>(values: T[], random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function createCard(ownerId: string, type: CardType): Card {
  return { id: randomUUID(), ownerId, type, zone: "hand" };
}

export function createGameConfig(playerCount: number): GameConfig {
  const believersByCount: Record<number, number> = {
    5: 1,
    6: 2,
    7: 2,
    8: 3,
    9: 3,
    10: 4
  };
  const giantBladesByCount: Record<number, number> = {
    5: 0,
    6: 0,
    7: 1,
    8: 1,
    9: 2,
    10: 2
  };
  if (!(playerCount in believersByCount)) {
    throw new Error("游戏人数必须为5至10人");
  }
  const roles: Role[] = ["whiteRose", "bishop", "doubleBlade", "darkBlade"];
  roles.push(...Array.from({ length: believersByCount[playerCount] }, () => "believer" as const));
  roles.push(
    ...Array.from({ length: giantBladesByCount[playerCount] }, () => "giantBlade" as const)
  );
  return {
    playerCount,
    roles,
    sacrificeTarget: playerCount - 3,
    deathTarget: playerCount - 2,
    maxRounds: playerCount
  };
}

export class GameRoom {
  readonly pin: string;
  readonly players: Player[] = [];
  stage: GameStage = "lobby";
  config: GameConfig | null = null;
  coinHolderId?: string;
  activePlayerId?: string;
  round = 0;
  winner?: Faction | "aborted";
  message = "等待玩家加入";
  roundReveal: PublicCard[] = [];
  private roundHistory: RoundHistoryEntry[] = [];
  private centralGhostAvailable = false;
  private order: string[] = [];
  private turnIndex = 0;
  private plays = new Map<string, string | null>();
  private currentCrystal?: PublicCrystal;
  private modifiers = EMPTY_MODIFIERS();
  private darkBladeVision = false;
  private endProposalActive = false;
  private endVoteProposerId?: string;
  private readonly random: () => number;

  constructor(pin = GameRoom.createPin(), random: () => number = Math.random) {
    this.pin = pin;
    this.random = random;
  }

  static fromSnapshot(snapshot: GameRoomSnapshot, random: () => number = Math.random): GameRoom {
    const room = new GameRoom(snapshot.pin, random);
    room.players.push(
      ...snapshot.players.map((player) => ({
        ...player,
        socketId: undefined,
        online: false,
        endVote: player.endVote ?? false,
        endVoteCast: player.endVoteCast ?? false
      }))
    );
    room.stage = snapshot.stage;
    room.config = snapshot.config;
    room.coinHolderId = snapshot.coinHolderId;
    room.activePlayerId = snapshot.activePlayerId;
    room.round = snapshot.round;
    room.winner = snapshot.winner;
    room.message = snapshot.message;
    room.roundReveal = snapshot.roundReveal;
    room.roundHistory = (snapshot.roundHistory ?? []).map((entry) => ({
      ...entry,
      plays: entry.plays ?? []
    }));
    room.centralGhostAvailable = snapshot.centralGhostAvailable;
    room.order = snapshot.order;
    room.turnIndex = snapshot.turnIndex;
    room.plays = new Map(snapshot.plays);
    room.modifiers = {
      ...snapshot.modifiers,
      mustPlay: new Set(snapshot.modifiers.mustPlay),
      lockedCards: new Map(snapshot.modifiers.lockedCards),
      pairMakeup: snapshot.modifiers.pairMakeup ?? false
    };
    room.darkBladeVision = snapshot.darkBladeVision;
    room.currentCrystal = snapshot.currentCrystal;
    room.endProposalActive = snapshot.endProposalActive ?? false;
    room.endVoteProposerId = snapshot.endVoteProposerId;
    return room;
  }

  static createPin(): string {
    return randomBytes(3).readUIntBE(0, 3).toString().padStart(8, "0").slice(0, 6);
  }

  snapshot(): GameRoomSnapshot {
    return {
      pin: this.pin,
      players: this.players.map(({ socketId: _socketId, ...player }) => player),
      stage: this.stage,
      config: this.config,
      coinHolderId: this.coinHolderId,
      activePlayerId: this.activePlayerId,
      round: this.round,
      winner: this.winner,
      message: this.message,
      roundReveal: this.roundReveal,
      roundHistory: this.roundHistory,
      centralGhostAvailable: this.centralGhostAvailable,
      order: this.order,
      turnIndex: this.turnIndex,
      plays: [...this.plays.entries()],
      modifiers: {
        ...this.modifiers,
        mustPlay: [...this.modifiers.mustPlay],
        lockedCards: [...this.modifiers.lockedCards.entries()]
      },
      darkBladeVision: this.darkBladeVision,
      currentCrystal: this.currentCrystal,
      endProposalActive: this.endProposalActive,
      endVoteProposerId: this.endVoteProposerId
    };
  }

  addPlayer(nickname: string, socketId?: string, token?: string): Player {
    if (this.stage !== "lobby") throw new Error("游戏已经开始");
    if (this.players.length >= 10) throw new Error("房间已满");
    const cleanName = nickname.trim().slice(0, 16);
    if (!cleanName) throw new Error("请输入昵称");
    const player: Player = {
      id: randomUUID(),
      token: token ?? randomUUID(),
      socketId,
      nickname: cleanName,
      seat: this.players.length + 1,
      online: true,
      isHost: this.players.length === 0,
      cards: [],
      crystalUsed: false,
      endVote: false,
      endVoteCast: false
    };
    this.players.push(player);
    this.message = `${this.players.length}/10 名玩家已加入`;
    return player;
  }

  reconnect(token: string, socketId: string): Player {
    const player = this.players.find((candidate) => candidate.token === token);
    if (!player) throw new Error("重连凭证无效");
    player.socketId = socketId;
    player.online = true;
    return player;
  }

  disconnect(socketId: string): void {
    const player = this.players.find((candidate) => candidate.socketId === socketId);
    if (player) player.online = false;
  }

  getPlayerByToken(token: string): Player | undefined {
    return this.players.find((player) => player.token === token);
  }

  reorder(requesterId: string, orderedIds: string[]): void {
    this.assertHost(requesterId);
    if (this.stage !== "lobby") throw new Error("游戏进行中不能调整座位");
    if (
      orderedIds.length !== this.players.length ||
      new Set(orderedIds).size !== this.players.length ||
      orderedIds.some((id) => !this.players.some((player) => player.id === id))
    ) {
      throw new Error("座位列表无效");
    }
    orderedIds.forEach((id, index) => {
      this.requirePlayer(id).seat = index + 1;
    });
  }

  removePlayer(requesterId: string, targetId: string): void {
    this.assertHost(requesterId);
    if (this.stage !== "lobby") throw new Error("游戏开始后不能移出玩家");
    if (requesterId === targetId) throw new Error("房主不能移出自己");
    const index = this.players.findIndex((player) => player.id === targetId);
    if (index < 0) throw new Error("玩家不存在");
    this.players.splice(index, 1);
    this.sortedPlayers().forEach((player, seatIndex) => {
      player.seat = seatIndex + 1;
    });
    this.message = `${this.players.length}/10 名玩家已加入`;
  }

  start(requesterId: string): void {
    this.assertHost(requesterId);
    if (this.stage !== "lobby") throw new Error("游戏已经开始");
    this.config = createGameConfig(this.players.length);
    const roles = shuffle(this.config.roles, this.random);
    const crystals = shuffle(
      Array.from({ length: 12 }, (_, index) => index + 1),
      this.random
    ).slice(0, this.players.length);
    this.sortedPlayers().forEach((player, index) => {
      const role = roles[index];
      player.role = role;
      player.crystal = crystals[index];
      player.crystalUsed = false;
      player.privateMessage = undefined;
      player.endVote = false;
      player.endVoteCast = false;
      player.cards = [createCard(player.id, "believer"), createCard(player.id, "ghost")];
      player.cards.push(createCard(player.id, role));
      if (role === "doubleBlade") {
        const ghost = player.cards.find((card) => card.type === "ghost");
        if (ghost) {
          player.cards = player.cards.filter((card) => card.id !== ghost.id);
          player.cards.push(createCard(player.id, "doubleBlade"));
          this.centralGhostAvailable = true;
        }
      }
    });
    this.stage = "initialCoin";
    this.round = 0;
    this.winner = undefined;
    this.darkBladeVision = false;
    this.roundHistory = [];
    this.clearEndProposal();
    this.resetRound();
    this.message = "房主请选择首位金币持有者";
  }

  chooseInitialCoin(requesterId: string, targetId: string): void {
    this.assertHost(requesterId);
    if (this.stage !== "initialCoin") throw new Error("当前不能选择首位金币持有者");
    this.requirePlayer(targetId);
    this.round = 1;
    this.beginCrystalTurn(targetId);
  }

  activateCrystal(requesterId: string, targetIds: string[] = []): void {
    if (this.stage !== "crystal" || requesterId !== this.coinHolderId) {
      throw new Error("当前不能发动该水晶");
    }
    const holder = this.requirePlayer(requesterId);
    if (!holder.crystal || holder.crystalUsed) throw new Error("水晶不可用");
    holder.privateMessage = undefined;
    const withCards = this.players.filter((player) => this.handCards(player).length > 0);
    const requireTarget = (index: number, excludeSelf = false): Player => {
      const target = this.requirePlayer(targetIds[index]);
      if (!withCards.includes(target)) throw new Error("目标已经没有手牌");
      if (excludeSelf && target.id === holder.id) throw new Error("不能选择自己");
      return target;
    };

    switch (holder.crystal) {
      case 1:
      case 12: {
        this.modifiers.mustPlay.add(requireTarget(0).id);
        break;
      }
      case 2:
        this.modifiers.noShuffle = true;
        break;
      case 3:
      case 4: {
        const target = this.adjacentPlayer(holder.id, holder.crystal === 3 ? 1 : -1);
        const cards = this.handCards(target);
        if (cards.length > 0) {
          const locked = cards[Math.floor(this.random() * cards.length)];
          this.modifiers.lockedCards.set(target.id, locked.id);
          this.modifiers.mustPlay.add(target.id);
        }
        break;
      }
      case 5: {
        const first = requireTarget(0);
        const second = requireTarget(1);
        if (first.id === second.id) throw new Error("必须选择两名不同玩家");
        this.modifiers.pair = { first: first.id, second: second.id };
        break;
      }
      case 6:
        break;
      case 7: {
        const target = this.requirePlayer(targetIds[0]);
        if (target.id === holder.id) throw new Error("不能选择自己");
        if (!this.centralGhostAvailable) throw new Error("中央已经没有备用幽魂");
        target.cards.push(createCard(target.id, "ghost"));
        this.centralGhostAvailable = false;
        break;
      }
      case 8: {
        const left = this.adjacentPlayer(holder.id, -1);
        const right = this.adjacentPlayer(holder.id, 1);
        if (this.handCards(left).length > 0) this.modifiers.mustPlay.add(left.id);
        if (this.handCards(right).length > 0) this.modifiers.mustPlay.add(right.id);
        break;
      }
      case 9:
        this.darkBladeVision = true;
        break;
      case 10:
        this.modifiers.crystal10 = true;
        break;
      case 11: {
        const target = requireTarget(0);
        const cards = this.handCards(target);
        const card = cards[Math.floor(this.random() * cards.length)];
        holder.privateMessage = `你偷看到 ${this.label(target.id)} 的一张【${this.cardName(card.type)}】`;
        break;
      }
      default:
        throw new Error("未知水晶");
    }

    holder.crystalUsed = true;
    const skill = CRYSTALS[holder.crystal];
    this.currentCrystal = {
      number: holder.crystal,
      name: skill.name,
      description: skill.description,
      ownerId: holder.id
    };
    this.order = this.orderFrom(holder.id);
    if (holder.crystal === 6) {
      this.order = [...this.order.slice(1), holder.id];
    }
    this.ensurePairOrder();
    this.turnIndex = 0;
    this.stage = "choosing";
    this.activePlayerId = this.order[0];
    this.message = `${this.label(holder.id)}发动了水晶${holder.crystal}「${skill.name}」。轮到 ${this.label(this.activePlayerId)} 选择暗牌`;
  }

  playCard(requesterId: string, cardId: string | null): void {
    if (this.stage !== "choosing" || requesterId !== this.activePlayerId) {
      throw new Error("还没有轮到你");
    }
    const player = this.requirePlayer(requesterId);
    const constraints = this.constraintsFor(requesterId);
    if (cardId === null) {
      if (constraints.mustPlay) throw new Error("本轮你必须出牌");
    } else {
      if (constraints.cannotPlay) throw new Error("本轮你不能出牌");
      const card = this.handCards(player).find((candidate) => candidate.id === cardId);
      if (!card) throw new Error("手牌不存在");
      if (constraints.lockedCardId && constraints.lockedCardId !== cardId) {
        throw new Error("本轮只能打出水晶随机指定的牌");
      }
      card.zone = "pending";
    }
    this.plays.set(requesterId, cardId);
    this.advanceTurn();
  }

  handleCrystal10(requesterId: string, targetId?: string, replacementCardId?: string): void {
    if (this.stage !== "crystal10") throw new Error("当前没有替换步骤");
    if (!this.modifiers.replacementPlayerId) {
      if (requesterId !== this.coinHolderId) throw new Error("只有水晶持有者可以选择目标");
      if (!targetId) {
        this.revealRound();
        return;
      }
      const eligible = this.crystal10EligibleTargets();
      if (!eligible.includes(targetId)) throw new Error("该玩家不能替换暗牌");
      this.modifiers.replacementPlayerId = targetId;
      this.activePlayerId = targetId;
      this.message = `${this.label(targetId)}请选择替换牌`;
      return;
    }
    if (requesterId !== this.modifiers.replacementPlayerId || !replacementCardId) {
      throw new Error("当前不能替换");
    }
    const player = this.requirePlayer(requesterId);
    const replacement = this.handCards(player).find((card) => card.id === replacementCardId);
    if (!replacement) throw new Error("替换牌不存在");
    const originalId = this.plays.get(requesterId);
    const original = player.cards.find((card) => card.id === originalId);
    if (!original) throw new Error("原暗牌不存在");
    original.zone = "hand";
    replacement.zone = "pending";
    this.plays.set(requesterId, replacement.id);
    this.revealRound();
  }

  chooseNextCoin(requesterId: string, targetId: string): void {
    if (this.stage !== "nextCoin" || requesterId !== this.coinHolderId) {
      throw new Error("当前不能传递金币");
    }
    const target = this.requirePlayer(targetId);
    if (target.crystalUsed) throw new Error("该玩家的水晶已经使用");
    this.resetRound();
    this.round += 1;
    this.beginCrystalTurn(target.id);
  }

  proposeEnd(requesterId: string): void {
    if (this.stage === "lobby" || this.stage === "ended") throw new Error("当前不能投票");
    if (this.endProposalActive) throw new Error("已经有提前结束投票进行中");
    this.requirePlayer(requesterId);
    this.endProposalActive = true;
    this.endVoteProposerId = requesterId;
    this.message = `${this.label(requesterId)}发起提前结束投票`;
    this.castEndVote(requesterId, true);
  }

  castEndVote(requesterId: string, agree: boolean): void {
    if (this.stage === "lobby" || this.stage === "ended") throw new Error("当前不能投票");
    if (!this.endProposalActive) throw new Error("当前没有提前结束投票");
    const player = this.requirePlayer(requesterId);
    player.endVote = agree;
    player.endVoteCast = true;
    if (this.endVotes() > this.players.length / 2) {
      this.endProposalActive = false;
      this.winner = "aborted";
      this.stage = "ended";
      this.activePlayerId = undefined;
      this.message = "超过半数玩家同意，本局提前结束";
      return;
    }
    if (this.players.every((item) => item.endVoteCast)) {
      this.clearEndProposal();
      this.message = "提前结束未获过半数同意，游戏继续";
    }
  }

  newGame(requesterId: string): void {
    this.assertHost(requesterId);
    if (this.stage !== "ended") throw new Error("本局尚未结束");
    this.stage = "lobby";
    this.config = null;
    this.coinHolderId = undefined;
    this.activePlayerId = undefined;
    this.round = 0;
    this.winner = undefined;
    this.centralGhostAvailable = false;
    this.darkBladeVision = false;
    this.roundHistory = [];
    this.players.forEach((player) => {
      player.role = undefined;
      player.cards = [];
      player.crystal = undefined;
      player.crystalUsed = false;
      player.privateMessage = undefined;
      player.endVote = false;
      player.endVoteCast = false;
    });
    this.clearEndProposal();
    this.resetRound();
    this.message = "准备开始新的一局";
  }

  publicState(): PublicState {
    const cardsIn = (zone: CardZone): PublicCard[] =>
      this.players
        .flatMap((player) => player.cards)
        .filter((card) => card.zone === zone)
        .map((card) => ({ id: card.id, type: card.type, zone: card.zone }));
    return {
      pin: this.pin,
      stage: this.stage,
      players: this.sortedPlayers().map((player) => {
        const crystalRevealed =
          player.crystalUsed || this.currentCrystal?.ownerId === player.id;
        return {
          id: player.id,
          nickname: player.nickname,
          seat: player.seat,
          online: player.online,
          isHost: player.isHost,
          crystalUsed: player.crystalUsed,
          revealedCrystal: crystalRevealed ? player.crystal : undefined,
          revealedCrystalName:
            crystalRevealed && player.crystal ? CRYSTALS[player.crystal].name : undefined,
          hasActed: this.plays.has(player.id),
          action: this.plays.has(player.id)
            ? this.plays.get(player.id)
              ? "played"
              : "passed"
            : undefined,
          endVote: player.endVote,
          endVoteCast: player.endVoteCast,
          role: this.stage === "ended" ? player.role : undefined
        };
      }),
      config: this.config,
      coinHolderId: this.coinHolderId,
      activePlayerId: this.activePlayerId,
      round: this.round,
      board: {
        sacrifice: cardsIn("sacrifice"),
        death: cardsIn("death"),
        sanctuary: cardsIn("sanctuary"),
        removed: cardsIn("removed")
      },
      roundReveal: this.roundReveal,
      roundHistory: this.roundHistory,
      currentCrystal: this.currentCrystal,
      message: this.message,
      winner: this.winner,
      endVotes: this.endVotes(),
      endVotesNeeded: Math.floor(this.players.length / 2) + 1,
      endProposalActive: this.endProposalActive,
      endVoteProposerId: this.endVoteProposerId
    };
  }

  privateState(playerId: string): PrivateState {
    const player = this.requirePlayer(playerId);
    const sightPlayers =
      player.role && SIGHT_ROLES.has(player.role)
        ? this.sortedPlayers()
            .filter(
              (candidate) =>
                candidate.id !== player.id &&
                candidate.role !== undefined &&
                SIGHT_ROLES.has(candidate.role)
            )
            .map(({ id, seat, nickname }) => ({ id, seat, nickname }))
        : player.role === "darkBlade" && this.darkBladeVision
          ? this.sortedPlayers()
              .filter(
                (candidate) => candidate.role === "whiteRose" || candidate.role === "bishop"
              )
              .map(({ id, seat, nickname }) => ({ id, seat, nickname }))
          : [];
    const constraints = this.constraintsFor(playerId);
    return {
      playerId,
      token: player.token,
      role: player.role,
      faction: player.role ? factionForRole(player.role) : undefined,
      hand: player.cards.map(({ id, type, zone }) => ({ id, type, zone })),
      crystal: player.crystal,
      crystalUsed: player.crystalUsed,
      sightPlayers,
      privateMessage: player.privateMessage,
      lockedCardId: constraints.lockedCardId,
      mustPlay: constraints.mustPlay,
      cannotPlay: constraints.cannotPlay,
      canAct: this.activePlayerId === playerId,
      eligibleTargets: this.eligibleTargetsFor(playerId),
      crystal10NeedsReplacement:
        this.stage === "crystal10" && this.modifiers.replacementPlayerId === playerId,
      endVote: player.endVote,
      endVoteCast: player.endVoteCast
    };
  }

  private constraintsFor(playerId: string): {
    mustPlay: boolean;
    cannotPlay: boolean;
    lockedCardId?: string;
  } {
    let mustPlay = this.modifiers.mustPlay.has(playerId);
    const cannotPlay = false;
    if (this.modifiers.pairMakeup && this.modifiers.pair?.first === playerId) {
      mustPlay = true;
    }
    const lockedCardId = this.modifiers.lockedCards.get(playerId);
    return {
      mustPlay: cannotPlay ? false : mustPlay || Boolean(lockedCardId),
      cannotPlay,
      lockedCardId
    };
  }

  private eligibleTargetsFor(playerId: string): string[] {
    const player = this.requirePlayer(playerId);
    if (this.stage === "crystal" && playerId === this.coinHolderId && player.crystal) {
      const withCards = this.players.filter((candidate) => this.handCards(candidate).length > 0);
      if (player.crystal === 7) {
        return this.players.filter((item) => item.id !== playerId).map((item) => item.id);
      }
      if ([1, 5, 11, 12].includes(player.crystal)) return withCards.map((item) => item.id);
    }
    if (this.stage === "nextCoin" && playerId === this.coinHolderId) {
      return this.players.filter((candidate) => !candidate.crystalUsed).map((candidate) => candidate.id);
    }
    if (this.stage === "crystal10" && playerId === this.coinHolderId) {
      return this.crystal10EligibleTargets();
    }
    return [];
  }

  private advanceTurn(): void {
    this.turnIndex += 1;
    if (this.turnIndex < this.order.length) {
      this.activePlayerId = this.order[this.turnIndex];
      this.message = `轮到 ${this.label(this.activePlayerId)} 选择暗牌`;
      return;
    }
    this.activePlayerId = undefined;
    if (this.needsPairMakeup()) {
      const firstId = this.modifiers.pair!.first;
      this.modifiers.pairMakeup = true;
      this.modifiers.mustPlay.add(firstId);
      this.activePlayerId = firstId;
      this.message = `${this.label(firstId)}未出牌而${this.label(this.modifiers.pair!.second)}出了牌，必须补出一张牌`;
      this.requirePlayer(firstId).privateMessage = "绑定的第二人出了牌，你必须补出一张暗牌";
      return;
    }
    if (this.modifiers.crystal10 && this.crystal10EligibleTargets().length > 0) {
      this.stage = "crystal10";
      this.activePlayerId = this.coinHolderId;
      this.message = `${this.label(this.coinHolderId!)}决定是否让一名玩家替换暗牌`;
    } else {
      this.revealRound();
    }
  }

  private revealRound(): void {
    const playedCards = [...this.plays.values()]
      .filter((cardId): cardId is string => Boolean(cardId))
      .map((cardId) => this.players.flatMap((player) => player.cards).find((card) => card.id === cardId)!)
      .filter(Boolean);
    const revealed = this.modifiers.noShuffle ? playedCards : shuffle(playedCards, this.random);
    const hasBlade = revealed.some((card) => BLADE_CARDS.has(card.type));
    const hasWhiteRose = revealed.some((card) => card.type === "whiteRose");
    for (const card of revealed) {
      if (card.type === "ghost") card.zone = "removed";
      else if (BLADE_CARDS.has(card.type)) card.zone = "death";
      else if (card.type === "whiteRose") card.zone = hasBlade ? "death" : "sanctuary";
      else if (BUD_CARDS.has(card.type)) card.zone = hasBlade ? "death" : "sacrifice";
    }
    this.roundReveal = revealed.map((card) => ({
      id: card.id,
      type: card.type,
      zone: card.zone,
      ownerId: this.modifiers.noShuffle ? card.ownerId : undefined
    }));
    this.roundHistory.push({
      round: this.round,
      coinHolderId: this.coinHolderId,
      crystal: this.currentCrystal,
      plays: this.sortedPlayers().map((player) => ({
        playerId: player.id,
        seat: player.seat,
        nickname: player.nickname,
        action: this.plays.get(player.id) ? "played" : "passed"
      })),
      cards: this.roundReveal
    });
    if (hasBlade && hasWhiteRose) {
      this.finish("blade", "白蔷薇与血刃同时出现，血刃阵营获胜");
      return;
    }
    const sacrificeCount = this.countZone("sacrifice", BUD_CARDS);
    const deathCount = this.countZone("death", BUD_CARDS);
    const whiteRoseSafe = this.players
      .flatMap((player) => player.cards)
      .some((card) => card.type === "whiteRose" && card.zone === "sanctuary");
    if (whiteRoseSafe && this.config && sacrificeCount >= this.config.sacrificeTarget) {
      this.finish("rose", "白蔷薇安全抵达且献祭数量达标，白蔷薇阵营获胜");
      return;
    }
    if (this.config && deathCount >= this.config.deathTarget) {
      this.finish("blade", "死亡花苞数量达标，血刃阵营获胜");
      return;
    }
    if (this.players.every((player) => player.crystalUsed)) {
      const leftoverBuds = this.players.some((player) =>
        this.handCards(player).some((card) => BUD_CARDS.has(card.type))
      );
      const leftoverWhiteRose = this.players.some((player) =>
        this.handCards(player).some((card) => card.type === "whiteRose")
      );
      if (leftoverBuds) {
        this.finish("blade", "游戏结束时仍有花苞留在手牌中，血刃阵营获胜");
        return;
      }
      if (leftoverWhiteRose) {
        this.finish("blade", "最终回合后白蔷薇仍留在手牌中，血刃阵营获胜");
        return;
      }
      this.finish("rose", "最终回合后白蔷薇阵营已打出全部关键手牌，白蔷薇阵营获胜");
      return;
    }
    this.stage = "nextCoin";
    this.activePlayerId = this.coinHolderId;
    this.message = `${this.label(this.coinHolderId!)}请选择下一位金币持有者`;
  }

  private finish(winner: Faction, message: string): void {
    this.winner = winner;
    this.stage = "ended";
    this.activePlayerId = undefined;
    this.message = message;
  }

  private beginCrystalTurn(playerId: string): void {
    const holder = this.requirePlayer(playerId);
    this.coinHolderId = holder.id;
    this.stage = "crystal";
    this.activePlayerId = holder.id;
    if (!holder.crystal) throw new Error("该玩家没有水晶");
    const skill = CRYSTALS[holder.crystal];
    this.currentCrystal = {
      number: holder.crystal,
      name: skill.name,
      description: skill.description,
      ownerId: holder.id
    };
    this.message = `${this.label(holder.id)}必须发动水晶${holder.crystal}「${skill.name}」`;
    if (!TARGET_CRYSTALS.has(holder.crystal)) {
      this.activateCrystal(holder.id);
    }
  }

  private resetRound(): void {
    this.plays.clear();
    this.modifiers = EMPTY_MODIFIERS();
    this.order = [];
    this.turnIndex = 0;
    this.roundReveal = [];
    this.activePlayerId = undefined;
    this.currentCrystal = undefined;
    this.players.forEach((player) => {
      player.privateMessage = undefined;
    });
  }

  private ensurePairOrder(): void {
    const pair = this.modifiers.pair;
    if (!pair) return;
    const firstIndex = this.order.indexOf(pair.first);
    const secondIndex = this.order.indexOf(pair.second);
    if (firstIndex < 0 || secondIndex < 0 || firstIndex < secondIndex) return;
    [this.order[firstIndex], this.order[secondIndex]] = [this.order[secondIndex], this.order[firstIndex]];
  }

  private needsPairMakeup(): boolean {
    const pair = this.modifiers.pair;
    if (!pair || this.modifiers.pairMakeup) return false;
    if (this.plays.get(pair.first) !== null) return false;
    if (!this.plays.get(pair.second)) return false;
    return this.handCards(this.requirePlayer(pair.first)).length > 0;
  }

  private crystal10EligibleTargets(): string[] {
    return this.players
      .filter(
        (player) =>
          Boolean(this.plays.get(player.id)) &&
          this.handCards(player).length > 0
      )
      .map((player) => player.id);
  }

  private orderFrom(startId: string): string[] {
    const players = this.sortedPlayers();
    const index = players.findIndex((player) => player.id === startId);
    return [...players.slice(index), ...players.slice(0, index)].map((player) => player.id);
  }

  private adjacentPlayer(playerId: string, offset: -1 | 1): Player {
    const players = this.sortedPlayers();
    const index = players.findIndex((player) => player.id === playerId);
    return players[(index + offset + players.length) % players.length];
  }

  private handCards(player: Player): Card[] {
    return player.cards.filter((card) => card.zone === "hand");
  }

  private countZone(zone: CardZone, types: Set<CardType>): number {
    return this.players
      .flatMap((player) => player.cards)
      .filter((card) => card.zone === zone && types.has(card.type)).length;
  }

  private sortedPlayers(): Player[] {
    return [...this.players].sort((left, right) => left.seat - right.seat);
  }

  private requirePlayer(playerId: string | undefined): Player {
    const player = this.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error("玩家不存在");
    return player;
  }

  private assertHost(playerId: string): void {
    if (!this.requirePlayer(playerId).isHost) throw new Error("只有房主可以执行该操作");
  }

  private label(playerId: string): string {
    const player = this.requirePlayer(playerId);
    return `${player.seat}号玩家 ${player.nickname}`;
  }

  private cardName(type: CardType): string {
    const names: Record<CardType, string> = {
      whiteRose: "白蔷薇",
      bishop: "司教",
      believer: "信者",
      doubleBlade: "双刃",
      giantBlade: "巨刃",
      darkBlade: "暗刃",
      ghost: "幽魂"
    };
    return names[type];
  }

  private endVotes(): number {
    return this.players.filter((player) => player.endVote).length;
  }

  private clearEndProposal(): void {
    this.endProposalActive = false;
    this.endVoteProposerId = undefined;
    this.players.forEach((player) => {
      player.endVote = false;
      player.endVoteCast = false;
    });
  }
}
