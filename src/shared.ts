export type Role =
  | "whiteRose"
  | "bishop"
  | "believer"
  | "doubleBlade"
  | "giantBlade"
  | "darkBlade";

export type CardType = Role | "ghost";
export type Faction = "rose" | "blade";
export type CardZone = "hand" | "pending" | "sacrifice" | "death" | "sanctuary" | "removed";
export type GameStage =
  | "lobby"
  | "initialCoin"
  | "crystal"
  | "choosing"
  | "crystal10"
  | "nextCoin"
  | "ended";

export interface PublicPlayer {
  id: string;
  nickname: string;
  seat: number;
  online: boolean;
  isHost: boolean;
  crystalUsed: boolean;
  revealedCrystal?: number;
  revealedCrystalName?: string;
  hasActed: boolean;
  action?: "played" | "passed";
  endVote: boolean;
  endVoteCast: boolean;
  role?: Role;
}

export interface PublicCrystal {
  number: number;
  name: string;
  description: string;
  ownerId: string;
}

export interface RoundHistoryPlay {
  playerId: string;
  seat: number;
  nickname: string;
  action: "played" | "passed";
}

export interface RoundHistoryEntry {
  round: number;
  coinHolderId?: string;
  crystal?: PublicCrystal;
  plays: RoundHistoryPlay[];
  cards: PublicCard[];
}

export interface PublicCard {
  id: string;
  type: CardType;
  ownerId?: string;
  zone: CardZone;
}

export interface GameConfig {
  playerCount: number;
  roles: Role[];
  sacrificeTarget: number;
  deathTarget: number;
  maxRounds: number;
}

export interface PublicState {
  pin: string;
  stage: GameStage;
  players: PublicPlayer[];
  config: GameConfig | null;
  coinHolderId?: string;
  activePlayerId?: string;
  round: number;
  board: {
    sacrifice: PublicCard[];
    death: PublicCard[];
    sanctuary: PublicCard[];
    removed: PublicCard[];
  };
  roundReveal: PublicCard[];
  roundHistory: RoundHistoryEntry[];
  currentCrystal?: PublicCrystal;
  message: string;
  winner?: Faction | "aborted";
  endVotes: number;
  endVotesNeeded: number;
  endProposalActive: boolean;
  endVoteProposerId?: string;
}

export interface PrivateCard {
  id: string;
  type: CardType;
  zone: CardZone;
}

export interface PrivateState {
  playerId: string;
  token: string;
  role?: Role;
  faction?: Faction;
  hand: PrivateCard[];
  crystal?: number;
  crystalUsed: boolean;
  sightPlayers: Array<{ id: string; seat: number; nickname: string }>;
  privateMessage?: string;
  lockedCardId?: string;
  mustPlay: boolean;
  cannotPlay: boolean;
  canAct: boolean;
  eligibleTargets: string[];
  crystal10NeedsReplacement: boolean;
  endVote: boolean;
  endVoteCast: boolean;
}

export interface StatePayload {
  public: PublicState;
  private: PrivateState;
}

export interface Ack<T = undefined> {
  ok: boolean;
  data?: T;
  error?: string;
}

export const ROLE_NAMES: Record<Role, string> = {
  whiteRose: "白蔷薇",
  bishop: "司教",
  believer: "信者",
  doubleBlade: "双刃",
  giantBlade: "巨刃",
  darkBlade: "暗刃"
};

export const CARD_NAMES: Record<CardType, string> = {
  ...ROLE_NAMES,
  ghost: "幽魂"
};

export const CRYSTALS: Record<number, { name: string; description: string }> = {
  1: {
    name: "指定某人必须出牌",
    description: "选择一名仍有手牌的玩家。该玩家轮到自己时必须出牌，但行动顺序不变。"
  },
  2: {
    name: "本回合不混洗",
    description: "所有玩家选牌后直接按来源公开，所有人会知道每张牌由谁打出。"
  },
  3: {
    name: "右边随机抽一张手牌",
    description: "随机锁定右侧玩家的一张牌且不公开。该玩家本轮必须打出这张牌，不能跳过。"
  },
  4: {
    name: "左边随机抽一张手牌",
    description: "随机锁定左侧玩家的一张牌且不公开。该玩家本轮必须打出这张牌，不能跳过。"
  },
  5: {
    name: "指定两人出牌",
    description: "依次指定A、B，两人按A→B的顺序选择是否出牌。若A不出但B出牌，则本轮结束前A必须补出一张牌。"
  },
  6: {
    name: "我最后决定是否出牌",
    description: "金币持有者由本轮第一位改为最后一位决定是否出牌。"
  },
  7: {
    name: "指定某人拿一张幽魂",
    description: "选择自己以外的一名玩家，将中央备用幽魂加入该玩家手牌。"
  },
  8: {
    name: "左右两家有牌必须出牌",
    description: "左右相邻玩家只要仍有手牌，本轮就必须在自己的正常轮次出牌。"
  },
  9: {
    name: "暗刃看白蔷薇和司教",
    description: "仅向暗刃玩家私密显示白蔷薇与司教玩家的座位号和昵称。"
  },
  10: {
    name: "最后决定是否替换出牌",
    description: "所有人首次选牌后，可令一名已出牌且仍有手牌的玩家（可以是自己）自行选择一张手牌替换暗牌。"
  },
  11: {
    name: "抽某人一张牌偷看",
    description: "选择一名有手牌的玩家，随机偷看其一张牌后归还；可以在线下选择公开、隐瞒或说谎。"
  },
  12: {
    name: "指定某人必须出牌",
    description: "选择一名仍有手牌的玩家。该玩家轮到自己时必须出牌，但行动顺序不变。"
  }
};

export const DEFAULT_PUBLIC_URL = "https://blades-rose.onrender.com";

export function factionForRole(role: Role): Faction {
  return role === "doubleBlade" || role === "giantBlade" || role === "darkBlade"
    ? "blade"
    : "rose";
}
