import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { QRCodeSVG } from "qrcode.react";
import { io } from "socket.io-client";
import {
  CARD_NAMES,
  CRYSTALS,
  ROLE_NAMES,
  factionForRole,
  type Ack,
  type Faction,
  type PrivateCard,
  type PublicCard,
  type PublicPlayer,
  type RoundHistoryEntry,
  type StatePayload
} from "./shared.ts";

const socket = io({ autoConnect: true });
const SESSION_KEY = "blades-rose-session";
const queryPin = new URLSearchParams(window.location.search).get("pin") ?? "";

interface Session {
  pin: string;
  token: string;
}

interface RoomEntry extends Session {
  state: StatePayload;
}

function getSession(): Session | null {
  try {
    const value = localStorage.getItem(SESSION_KEY);
    return value ? (JSON.parse(value) as Session) : null;
  } catch {
    return null;
  }
}

function playerLabel(player: Pick<PublicPlayer, "seat" | "nickname">): string {
  return `${player.seat}号玩家 ${player.nickname}`;
}

function crystalSkillLabel(number: number, name: string): string {
  return `水晶${number} · ${name}`;
}

function cardTone(card: PrivateCard["type"]): string {
  if (card === "ghost") return "ghost";
  if (card === "doubleBlade" || card === "giantBlade" || card === "darkBlade") return "blade";
  return "rose";
}

function defaultSelectedPlay(payload: StatePayload): string | "skip" | null {
  if (payload.private.lockedCardId) return payload.private.lockedCardId;
  if (
    payload.public.stage === "choosing" &&
    payload.private.canAct &&
    payload.private.cannotPlay
  ) {
    return "skip";
  }
  return null;
}

function App() {
  const [state, setState] = useState<StatePayload | null>(null);
  const [nickname, setNickname] = useState("");
  const [pin, setPin] = useState(queryPin);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCrystals, setShowCrystals] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  const [selectedPlay, setSelectedPlay] = useState<string | "skip" | null>(null);
  const [joinBaseUrl, setJoinBaseUrl] = useState(window.location.origin);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [privateExpanded, setPrivateExpanded] = useState(false);
  const [handExpanded, setHandExpanded] = useState(false);
  const [showIdentity, setShowIdentity] = useState(false);
  const [seenIdentity, setSeenIdentity] = useState(false);
  const [viewPanel, setViewPanel] = useState<"board" | "history" | null>(null);
  const [resultOverlay, setResultOverlay] = useState<"round" | "winner" | null>(null);
  const [dismissedResultRound, setDismissedResultRound] = useState<number | null>(null);
  const [dismissedWinner, setDismissedWinner] = useState(false);
  const [showEndVote, setShowEndVote] = useState(false);

  useEffect(() => {
    const onState = (payload: StatePayload) => {
      setState(payload);
      setTargets([]);
      setSelectedPlay(defaultSelectedPlay(payload));
      setError("");
    };
    const resume = () => {
      const session = getSession();
      if (!session) return;
      socket.emit("room:resume", session, (ack: Ack<RoomEntry>) => {
        if (!ack.ok) {
          localStorage.removeItem(SESSION_KEY);
          setState(null);
        } else if (ack.data) {
          setState(ack.data.state);
          setSelectedPlay(defaultSelectedPlay(ack.data.state));
        }
      });
    };
    const onConnectionError = () => {
      setBusy(false);
      setError("无法连接游戏服务器，请刷新页面后重试");
    };
    const onRoomClosed = (payload: { message: string }) => {
      localStorage.removeItem(SESSION_KEY);
      setState(null);
      setBusy(false);
      setError(payload.message);
      window.history.replaceState({}, "", window.location.pathname);
    };
    socket.on("state", onState);
    socket.on("connect", resume);
    socket.on("connect_error", onConnectionError);
    socket.on("room:kicked", onRoomClosed);
    socket.on("room:dissolved", onRoomClosed);
    if (socket.connected) resume();
    fetch("/api/config")
      .then(
        (response) =>
          response.json() as Promise<{
            joinBaseUrl: string;
            lanUrl: string;
            publicUrl: string | null;
          }>
      )
      .then((config) => {
        const siteOrigin = window.location.origin.replace(/\/$/, "");
        const onPublicHost =
          window.location.hostname.endsWith("onrender.com") ||
          (window.location.protocol === "https:" &&
            window.location.hostname !== "localhost" &&
            window.location.hostname !== "127.0.0.1");
        const publicBase = config.publicUrl || (onPublicHost ? siteOrigin : null);
        setJoinBaseUrl(publicBase || config.joinBaseUrl || siteOrigin);
        setPublicUrl(publicBase);
      })
      .catch(() => undefined);
    return () => {
      socket.off("state", onState);
      socket.off("connect", resume);
      socket.off("connect_error", onConnectionError);
      socket.off("room:kicked", onRoomClosed);
      socket.off("room:dissolved", onRoomClosed);
    };
  }, []);

  useEffect(() => {
    if (!state || state.public.stage === "lobby") {
      setResultOverlay(null);
      setDismissedResultRound(null);
      setDismissedWinner(false);
      setShowEndVote(false);
      setShowIdentity(false);
      setSeenIdentity(false);
      setPrivateExpanded(false);
      setHandExpanded(false);
      return;
    }
    if (showIdentity) return;
    if (state.public.roundReveal.length > 0 && dismissedResultRound !== state.public.round) {
      setViewPanel(null);
      setResultOverlay("round");
      return;
    }
    if (state.public.stage === "ended" && !dismissedWinner) {
      setViewPanel(null);
      setResultOverlay("winner");
    }
  }, [state, dismissedResultRound, dismissedWinner, showIdentity]);

  useEffect(() => {
    if (!state || state.public.stage === "lobby" || !state.private.role || seenIdentity) return;
    setShowIdentity(true);
  }, [state, seenIdentity]);

  const needsHand = Boolean(
    state &&
      ((state.public.stage === "choosing" && state.private.canAct) ||
        state.private.crystal10NeedsReplacement)
  );

  useEffect(() => {
    if (!needsHand) setHandExpanded(false);
  }, [needsHand]);

  useEffect(() => {
    if (!state || state.public.stage === "lobby" || state.public.stage === "ended") {
      setShowEndVote(false);
      return;
    }
    if (state.public.endProposalActive && !state.private.endVoteCast) {
      setShowEndVote(true);
    }
    if (!state.public.endProposalActive) {
      setShowEndVote(false);
    }
  }, [state]);

  const emit = (event: string, input: unknown = {}) => {
    setBusy(true);
    setError("");
    socket.emit(event, input, (ack: Ack) => {
      setBusy(false);
      if (!ack.ok) setError(ack.error ?? "操作失败");
    });
  };

  const enterRoom = (mode: "create" | "join") => {
    if (!nickname.trim()) {
      setError("请输入昵称");
      return;
    }
    setBusy(true);
    socket.emit(
      mode === "create" ? "room:create" : "room:join",
      mode === "create" ? { nickname } : { nickname, pin },
      (ack: Ack<RoomEntry>) => {
        setBusy(false);
        if (!ack.ok || !ack.data) {
          setError(ack.error ?? "无法进入房间");
          return;
        }
        localStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ pin: ack.data.pin, token: ack.data.token } satisfies Session)
        );
        setPin(ack.data.pin);
        setState(ack.data.state);
        setSelectedPlay(defaultSelectedPlay(ack.data.state));
        window.history.replaceState({}, "", `?pin=${ack.data.pin}`);
      }
    );
  };

  if (!state) {
    return (
      <main className="landing">
        <section className="hero-card">
          <h1>血与刃的白蔷薇</h1>
          <label>
            你的昵称
            <input
              value={nickname}
              maxLength={16}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="输入昵称"
            />
          </label>
          <div className="join-row">
            <label>
              房间号
              <input
                value={pin}
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
                placeholder="6位房间号"
              />
            </label>
            <button disabled={busy || pin.length !== 6} onClick={() => enterRoom("join")}>
              {busy ? "正在连接..." : "加入房间"}
            </button>
          </div>
          <div className="divider">或者</div>
          <button className="secondary" disabled={busy} onClick={() => enterRoom("create")}>
            {busy ? "正在创建房间..." : "创建新房间"}
          </button>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  const self = state.public.players.find((player) => player.id === state.private.playerId)!;
  const isHost = self.isHost;
  const isCoinHolder = state.public.coinHolderId === self.id;
  const playerById = (id?: string) => state.public.players.find((player) => player.id === id);
  const joinUrl = `${joinBaseUrl}${window.location.pathname}?pin=${state.public.pin}`;

  const toggleTarget = (id: string, max: number) => {
    setTargets((current) => {
      if (current.includes(id)) return current.filter((target) => target !== id);
      return [...current, id].slice(-max);
    });
  };

  const crystal = state.private.crystal ? CRYSTALS[state.private.crystal] : undefined;
  const currentCrystal = state.public.currentCrystal;
  const crystalOwner = playerById(currentCrystal?.ownerId);
  const needsTargets = state.private.crystal
    ? [1, 5, 7, 11, 12].includes(state.private.crystal)
    : false;
  const targetCount = state.private.crystal === 5 ? 2 : needsTargets ? 1 : 0;
  const pendingPlay = state.public.stage === "choosing" && state.private.canAct;
  const pendingReplace = state.private.crystal10NeedsReplacement;
  const canSelectHand =
    (pendingPlay && !state.private.cannotPlay) || pendingReplace;
  const canConfirmPlay = pendingReplace
    ? Boolean(selectedPlay && selectedPlay !== "skip")
    : pendingPlay &&
      (state.private.cannotPlay
        ? selectedPlay === "skip"
        : state.private.mustPlay
          ? Boolean(selectedPlay && selectedPlay !== "skip")
          : selectedPlay === "skip" || Boolean(selectedPlay));
  const confirmPlay = () => {
    if (!canConfirmPlay || busy) return;
    if (pendingReplace && selectedPlay && selectedPlay !== "skip") {
      emit("game:crystal10", { replacementCardId: selectedPlay });
      return;
    }
    if (pendingPlay) {
      emit("game:play", { cardId: selectedPlay === "skip" ? null : selectedPlay });
    }
  };
  const showContextActions =
    (state.public.stage === "initialCoin" && isHost) ||
    (state.public.stage === "crystal" && isCoinHolder && targetCount > 0) ||
    (state.public.stage === "crystal10" &&
      (isCoinHolder || state.private.crystal10NeedsReplacement)) ||
    (state.public.stage === "nextCoin" && isCoinHolder) ||
    (state.public.stage === "ended" && isHost);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-identity">
          <p className="eyebrow">房间号 {state.public.pin}</p>
          <strong>{playerLabel(self)}</strong>
        </div>
        <nav className="topbar-actions">
          {state.public.stage === "lobby" && (
            <button className="top-action" onClick={() => setShowInvite(true)}>
              邀请好友
            </button>
          )}
          <button className="top-action" onClick={() => setShowCrystals(true)}>
            水晶图鉴
          </button>
          {state.public.stage !== "lobby" && state.public.stage !== "ended" && (
            <button
              className={`top-action ${state.public.endProposalActive ? "selected" : ""}`}
              onClick={() => {
                if (state.public.endProposalActive) {
                  setShowEndVote(true);
                  return;
                }
                if (window.confirm("确定向全员发起提前结束投票？")) {
                  setShowEndVote(true);
                  emit("game:endVote", { action: "propose" });
                }
              }}
            >
              {state.public.endProposalActive
                ? `结束 ${state.public.endVotes}/${state.public.endVotesNeeded}`
                : "结束"}
            </button>
          )}
          {isHost && (
            <button
              className="top-action danger"
              onClick={() => {
                if (window.confirm("确定解散房间？所有玩家都会返回首页。")) {
                  emit("room:dissolve");
                }
              }}
            >
              解散房间
            </button>
          )}
        </nav>
      </header>

      {state.public.stage === "lobby" ? (
        <Lobby
          state={state}
          isHost={isHost}
          busy={busy}
          emit={emit}
        />
      ) : (
        <div className="game-layout">
          <div className="view-switch">
            <button
              className={viewPanel === "board" ? "selected" : "secondary"}
              onClick={() => setViewPanel("board")}
            >
              主版图
            </button>
            <button
              className={viewPanel === "history" ? "selected" : "secondary"}
              onClick={() => setViewPanel("history")}
            >
              历史轮次
            </button>
          </div>

          <section className={`status-banner turn-banner ${currentCrystal ? "crystal-live" : ""}`}>
            <div className="turn-banner-row">
              <span>第 {state.public.round || 0} 轮</span>
              <strong>{state.public.message}</strong>
            </div>
            {currentCrystal && (
              <div className="crystal-broadcast">
                <p className="eyebrow">本轮公开水晶</p>
                <p className="crystal-announce">
                  {crystalOwner && (
                    <>
                      <span className="player-no">{crystalOwner.seat}号玩家</span>{" "}
                      <span className="owner-name">{crystalOwner.nickname}</span>
                      {" 的水晶 为 "}
                    </>
                  )}
                  <span className="crystal-no">水晶{currentCrystal.number}</span>
                  <span className="crystal-skill"> · {currentCrystal.name}</span>
                </p>
                <p className="crystal-desc">{currentCrystal.description}</p>
              </div>
            )}
          </section>

          <section className="panel compact-players-panel">
            <div className="section-heading compact-heading">
              <div>
                <p className="eyebrow">公共信息</p>
                <h2>玩家与水晶</h2>
              </div>
              <span className="muted">{state.public.players.length}人</span>
            </div>
            <div className="compact-player-grid">
              {state.public.players.map((player) => (
                <div
                  className={`compact-player ${
                    player.id === state.public.activePlayerId ? "active" : ""
                  } ${player.id === currentCrystal?.ownerId ? "crystal-owner" : ""}`}
                  key={player.id}
                >
                  <span className="compact-seat">{player.seat}</span>
                  <div className="compact-name">
                    <strong>{player.nickname}</strong>
                    <small>
                      {player.id === state.public.coinHolderId ? "金币 · " : ""}
                      {player.online ? "在线" : "离线"}
                    </small>
                  </div>
                  <span
                    className={`crystal-dot ${
                      player.crystalUsed ? "used" : player.revealedCrystal ? "active" : ""
                    }`}
                  >
                    {player.revealedCrystal ?? "?"}
                  </span>
                  {player.hasActed && (
                    <span className="action-mark">
                      {player.action === "played" ? "出" : "过"}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className={`panel identity-hub ${privateExpanded ? "expanded" : "collapsed"}`}>
            <div className="identity-header">
              <div>
                <p className="eyebrow">仅自己可见</p>
                <h2>{privateExpanded ? "你的私密信息" : "私密信息已收起"}</h2>
              </div>
              <button className="secondary collapse-button" onClick={() => setPrivateExpanded((value) => !value)}>
                {privateExpanded ? "收起" : "展开"}
              </button>
            </div>
            {privateExpanded && <IdentityDetails state={state} crystal={crystal} />}
          </section>

          {showContextActions && (
            <section className="panel actions context-actions">
              {state.public.stage === "initialCoin" && isHost && (
                <TargetPicker
                  title="选择首位金币持有者"
                  players={state.public.players}
                  selected={targets}
                  onToggle={(id) => toggleTarget(id, 1)}
                  onConfirm={() => emit("game:initialCoin", { targetId: targets[0] })}
                  canConfirm={targets.length === 1 && !busy}
                />
              )}

              {state.public.stage === "crystal" && isCoinHolder && targetCount > 0 && (
                <TargetPicker
                  title={
                    targetCount === 2
                      ? `必须发动水晶${state.private.crystal}，依次选择A、B玩家`
                      : `必须发动水晶${state.private.crystal}，选择目标玩家`
                  }
                  players={state.public.players.filter((player) =>
                    state.private.eligibleTargets.includes(player.id)
                  )}
                  selected={targets}
                  onToggle={(id) => toggleTarget(id, targetCount)}
                  onConfirm={() => emit("game:crystal", { targetIds: targets })}
                  canConfirm={targets.length === targetCount && !busy}
                />
              )}

              {state.public.stage === "crystal10" &&
                isCoinHolder &&
                !state.private.crystal10NeedsReplacement && (
                  <TargetPicker
                    title="选择一名已出牌的玩家替换暗牌，也可以选自己"
                    players={state.public.players.filter((player) =>
                      state.private.eligibleTargets.includes(player.id)
                    )}
                    selected={targets}
                    onToggle={(id) => toggleTarget(id, 1)}
                    onConfirm={() => emit("game:crystal10", { targetId: targets[0] })}
                    canConfirm={targets.length === 1 && !busy}
                    secondaryAction={() => emit("game:crystal10", {})}
                    secondaryLabel="不替换"
                  />
                )}

              {state.public.stage === "nextCoin" && isCoinHolder && (
                <TargetPicker
                  title="选择下一位金币持有者"
                  players={state.public.players.filter((player) =>
                    state.private.eligibleTargets.includes(player.id)
                  )}
                  selected={targets}
                  onToggle={(id) => toggleTarget(id, 1)}
                  onConfirm={() => emit("game:nextCoin", { targetId: targets[0] })}
                  canConfirm={targets.length === 1 && !busy}
                />
              )}

              {state.public.stage === "ended" && isHost && (
                <button onClick={() => emit("game:new")}>准备下一局</button>
              )}
            </section>
          )}

          <section
            className={`panel operation-panel ${
              pendingPlay || pendingReplace || handExpanded ? "expanded" : "collapsed"
            } ${pendingPlay || pendingReplace ? "live" : ""}`}
          >
            <div className="identity-header">
              <div>
                <p className="eyebrow">仅自己可见</p>
                <h2>
                  {pendingPlay || pendingReplace || handExpanded
                    ? pendingReplace
                      ? "选择替换暗牌"
                      : pendingPlay
                        ? "轮到你出牌"
                        : "你的手牌"
                    : `手牌已收起 · ${state.private.hand.filter((card) => card.zone === "hand").length}张`}
                </h2>
              </div>
              {!(pendingPlay || pendingReplace) && (
                <button
                  className="secondary collapse-button"
                  onClick={() => setHandExpanded((value) => !value)}
                >
                  {handExpanded ? "收起" : "展开"}
                </button>
              )}
            </div>
            {(pendingPlay || pendingReplace || handExpanded) && (
              <>
                <div className="hand">
                  {state.private.hand.map((card) => {
                    const selectable =
                      canSelectHand &&
                      card.zone === "hand" &&
                      (!state.private.lockedCardId || state.private.lockedCardId === card.id);
                    return (
                      <button
                        className={`game-card ${cardTone(card.type)} ${card.zone !== "hand" ? "spent" : ""} ${
                          state.private.lockedCardId === card.id ? "locked" : ""
                        } ${selectedPlay === card.id ? "selected" : ""}`}
                        key={card.id}
                        disabled={!selectable || busy}
                        onClick={() =>
                          setSelectedPlay((current) => (current === card.id ? null : card.id))
                        }
                      >
                        <strong>{CARD_NAMES[card.type]}</strong>
                        <small>
                          {card.zone === "hand"
                            ? selectedPlay === card.id
                              ? "已选择，待确认"
                              : state.private.lockedCardId === card.id
                                ? "本轮指定牌"
                                : "未使用"
                            : zoneName(card.zone)}
                        </small>
                      </button>
                    );
                  })}
                </div>
                {pendingPlay && state.private.cannotPlay && (
                  <p className="must-play-hint">本轮你不能出牌，请确认跳过</p>
                )}
                {pendingPlay && state.private.mustPlay && (
                  <p className="must-play-hint">
                    {state.private.privateMessage?.includes("补出")
                      ? "你必须补出一张暗牌"
                      : state.private.lockedCardId
                        ? "本轮必须打出被锁定的那张牌"
                        : "本轮必须出牌"}
                  </p>
                )}
                {pendingReplace && (
                  <p className="must-play-hint">选择一张手牌替换本轮暗牌，然后确认</p>
                )}
                {(pendingPlay || pendingReplace) && (
                  <div className="button-row play-confirm-row">
                    {pendingPlay && !state.private.mustPlay && !state.private.cannotPlay && (
                      <button
                        className={selectedPlay === "skip" ? "selected" : "secondary"}
                        disabled={busy}
                        onClick={() =>
                          setSelectedPlay((current) => (current === "skip" ? null : "skip"))
                        }
                      >
                        {selectedPlay === "skip" ? "已选择跳过" : "本轮跳过"}
                      </button>
                    )}
                    <button disabled={!canConfirmPlay || busy} onClick={confirmPlay}>
                      {pendingReplace
                        ? "确认替换暗牌"
                        : selectedPlay === "skip"
                          ? "确认跳过"
                          : "确认打出暗牌"}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

        </div>
      )}

      {error && <div className="toast">{error}</div>}
      {showInvite && (
        <InviteModal
          pin={state.public.pin}
          joinUrl={joinUrl}
          publicUrl={publicUrl}
          onClose={() => setShowInvite(false)}
        />
      )}
      {showCrystals && <CrystalGuide onClose={() => setShowCrystals(false)} />}
      {showIdentity && (
        <IdentityModal
          state={state}
          crystal={crystal}
          onClose={() => {
            setSeenIdentity(true);
            setShowIdentity(false);
          }}
        />
      )}
      {showEndVote && state.public.endProposalActive && state.public.stage !== "ended" && (
        <EndVoteModal
          proposer={playerById(state.public.endVoteProposerId)}
          votes={state.public.endVotes}
          needed={state.public.endVotesNeeded}
          players={state.public.players}
          hasCast={state.private.endVoteCast}
          agreed={state.private.endVote}
          busy={busy}
          onAgree={() => emit("game:endVote", { action: "agree" })}
          onReject={() => emit("game:endVote", { action: "reject" })}
          onClose={() => setShowEndVote(false)}
        />
      )}
      {viewPanel === "board" && (
        <BoardModal
          round={state.public.round}
          board={state.public.board}
          sacrificeTarget={state.public.config?.sacrificeTarget ?? 0}
          deathTarget={state.public.config?.deathTarget ?? 0}
          roundReveal={state.public.roundReveal}
          players={state.public.players}
          onClose={() => setViewPanel(null)}
        />
      )}
      {viewPanel === "history" && (
        <RoundHistory
          entries={state.public.roundHistory}
          players={state.public.players}
          onClose={() => setViewPanel(null)}
        />
      )}
      {resultOverlay === "round" && (
        <RoundResultModal
          entry={
            state.public.roundHistory.find((item) => item.round === state.public.round) ?? {
              round: state.public.round,
              coinHolderId: state.public.coinHolderId,
              crystal: state.public.currentCrystal,
              plays: [],
              cards: state.public.roundReveal
            }
          }
          players={state.public.players}
          onClose={() => {
            setDismissedResultRound(state.public.round);
            setResultOverlay(null);
          }}
        />
      )}
      {resultOverlay === "winner" && (
        <WinnerModal
          winner={state.public.winner}
          message={state.public.message}
          players={state.public.players}
          isHost={isHost}
          busy={busy}
          onNewGame={() => emit("game:new")}
          onClose={() => {
            setDismissedWinner(true);
            setResultOverlay(null);
          }}
        />
      )}
    </main>
  );
}

function Lobby({
  state,
  isHost,
  busy,
  emit
}: {
  state: StatePayload;
  isHost: boolean;
  busy: boolean;
  emit: (event: string, input?: unknown) => void;
}) {
  const players = state.public.players;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!isHost || !over || active.id === over.id) return;
    const oldIndex = players.findIndex((player) => player.id === active.id);
    const newIndex = players.findIndex((player) => player.id === over.id);
    const ordered = arrayMove(players, oldIndex, newIndex).map((player) => player.id);
    emit("room:reorder", { playerIds: ordered });
  };
  const config = useMemo(() => {
    const count = players.length;
    if (count < 5 || count > 10) return null;
    const believers = { 5: 1, 6: 2, 7: 2, 8: 3, 9: 3, 10: 4 }[count]!;
    const giants = { 5: 0, 6: 0, 7: 1, 8: 1, 9: 2, 10: 2 }[count]!;
    return {
      sacrifice: count - 3,
      death: count - 2,
      rounds: count,
      roles: `白蔷薇×1 · 司教×1 · 信者×${believers} · 双刃×1 · 暗刃×1${
        giants ? ` · 巨刃×${giants}` : ""
      }`
    };
  }, [players.length]);

  return (
    <>
      <section className="lobby-hero">
        <div>
          <h1>{players.length}<small>/10</small> 名玩家</h1>
          <p className={`hint-strong ${players.length >= 5 ? "ready" : ""}`}>
            {players.length < 5 ? `还需 ${5 - players.length} 人即可开始` : "人数已满足，可以开始"}
          </p>
        </div>
        <div className={`ready-orb ${players.length >= 5 ? "ready" : ""}`}>
          {players.length >= 5 ? "READY" : "WAIT"}
        </div>
      </section>

      <section className="panel config-panel">
        <div className="section-heading">
          <h2>本局配置</h2>
          <span className="config-status">{config ? "配置完成" : "等待5人"}</span>
        </div>
        {config ? (
          <>
            <div className="config-metrics">
              <div><strong>{config.sacrifice}</strong><span>献祭目标</span></div>
              <div><strong>{config.death}</strong><span>死亡目标</span></div>
              <div><strong>{config.rounds}</strong><span>最多轮数</span></div>
            </div>
            <p className="role-summary">{config.roles}</p>
          </>
        ) : (
          <p className="hint-strong">满 5 人后显示身份与胜利条件</p>
        )}
      </section>

      <section className="panel seats-panel">
        <div className="section-heading">
          <h2>座位</h2>
          {isHost && <span className="drag-hint">按住拖动排序</span>}
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={players.map((player) => player.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="players sortable-players">
              {players.map((player) => (
                <SortableSeat
                  key={player.id}
                  player={player}
                  enabled={isHost}
                  onKick={
                    isHost && !player.isHost
                      ? () => {
                          if (window.confirm(`确定移出 ${playerLabel(player)}？`)) {
                            emit("room:kick", { targetId: player.id });
                          }
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        {isHost ? (
          <div className="host-actions">
            <button
              className="start-button"
              disabled={busy || players.length < 5 || players.length > 10}
              onClick={() => emit("game:start")}
            >
              锁定座位并开始游戏
            </button>
            <button
              className="dissolve-button"
              onClick={() => {
                if (window.confirm("确定解散房间？所有玩家都会返回首页。")) {
                  emit("room:dissolve");
                }
              }}
            >
              解散房间
            </button>
          </div>
        ) : (
          <p className="hint-strong">等待房主开始游戏</p>
        )}
      </section>
    </>
  );
}

function SortableSeat({
  player,
  enabled,
  onKick
}: {
  player: PublicPlayer;
  enabled: boolean;
  onKick?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: player.id,
    disabled: !enabled
  });
  return (
    <div
      ref={setNodeRef}
      className={`player sortable-seat ${isDragging ? "dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span className="seat-number">{player.seat}</span>
      <div className="seat-name">
        <strong>{player.nickname}</strong>
        <small>
          {player.online ? "在线" : "离线"}
          {player.isHost ? " · 房主" : ""}
        </small>
      </div>
      {onKick && (
        <button className="kick-button" onClick={onKick}>
          移出
        </button>
      )}
      {enabled && (
        <span className="drag-handle" aria-label="拖动座位" {...attributes} {...listeners}>
          ⠿
        </span>
      )}
    </div>
  );
}

function IdentityDetails({
  state,
  crystal
}: {
  state: StatePayload;
  crystal?: { name: string; description: string };
}) {
  return (
    <div className="identity-details">
      <div className="identity-block">
        <h3>身份与阵营</h3>
        <div className="identity-title">
          <h2>{state.private.role ? ROLE_NAMES[state.private.role] : "等待身份"}</h2>
          {state.private.faction && (
            <span>{state.private.faction === "rose" ? "白蔷薇阵营" : "血刃阵营"}</span>
          )}
        </div>
        {state.private.sightPlayers.length > 0 ? (
          <div className="sight-list">
            {state.private.sightPlayers.map((player) => (
              <span key={player.id}>
                {playerLabel(player)}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted">你没有开局相认信息</p>
        )}
        {state.private.privateMessage && (
          <div className="notice">{state.private.privateMessage}</div>
        )}
      </div>
      <div className="identity-block crystal-block">
        <h3>你的水晶</h3>
        {crystal ? (
          <>
            <strong>
              {crystalSkillLabel(state.private.crystal ?? 0, crystal.name)}
            </strong>
            <p>{crystal.description}</p>
            <span className={`state-chip ${state.private.crystalUsed ? "used" : ""}`}>
              {state.private.crystalUsed ? "已使用" : "未使用"}
            </span>
          </>
        ) : (
          <p>尚未发放</p>
        )}
      </div>
    </div>
  );
}

function IdentityModal({
  state,
  crystal,
  onClose
}: {
  state: StatePayload;
  crystal?: { name: string; description: string };
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop identity-overlay">
      <section className="modal identity-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">仅自己可见</p>
            <h2>你的身份与水晶</h2>
          </div>
        </div>
        <IdentityDetails state={state} crystal={crystal} />
        <button className="result-dismiss" onClick={onClose}>
          知道了
        </button>
      </section>
    </div>
  );
}

function TargetPicker({
  title,
  players,
  selected,
  onToggle,
  onConfirm,
  canConfirm,
  secondaryAction,
  secondaryLabel
}: {
  title: string;
  players: PublicPlayer[];
  selected: string[];
  onToggle: (id: string) => void;
  onConfirm: () => void;
  canConfirm: boolean;
  secondaryAction?: () => void;
  secondaryLabel?: string;
}) {
  return (
    <div>
      <h2>{title}</h2>
      <div className="target-list">
        {players.map((player) => (
          <button
            className={selected.includes(player.id) ? "selected" : "secondary"}
            key={player.id}
            onClick={() => onToggle(player.id)}
          >
            {playerLabel(player)}
          </button>
        ))}
      </div>
      <div className="button-row">
        <button disabled={!canConfirm} onClick={onConfirm}>
          确认
        </button>
        {secondaryAction && (
          <button className="secondary" onClick={secondaryAction}>
            {secondaryLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function BoardZone({
  title,
  cards
}: {
  title: string;
  cards: Array<{ id: string; type: PrivateCard["type"] }>;
}) {
  return (
    <section className="board-zone">
      <h3>{title}</h3>
      <div className="card-row">
        {cards.length === 0 ? (
          <span className="muted">暂无</span>
        ) : (
          cards.map((card) => (
            <span className={`token ${cardTone(card.type)}`} key={card.id}>
              {CARD_NAMES[card.type]}
            </span>
          ))
        )}
      </div>
    </section>
  );
}

function InviteModal({
  pin,
  joinUrl,
  publicUrl,
  onClose
}: {
  pin: string;
  joinUrl: string;
  publicUrl: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<"pin" | "link" | null>(null);
  const copyText = async (value: string, kind: "pin" | "link") => {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal invite-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">邀请玩家</p>
            <h2>分享房间号</h2>
          </div>
          <button className="text-button" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="room-code">{pin}</p>
        <div className="qr">
          <QRCodeSVG value={joinUrl} size={220} level="M" />
        </div>
        <p className="hint-strong">扫码或分享房间号即可加入</p>
        {!publicUrl && (
          <p className="invite-warning">当前为局域网地址，请确保大家在同一 Wi‑Fi。</p>
        )}
        <div className="button-row invite-actions">
          <button className="secondary" onClick={() => copyText(pin, "pin")}>
            {copied === "pin" ? "房间号已复制" : "复制房间号"}
          </button>
          <button className="secondary" onClick={() => copyText(joinUrl, "link")}>
            {copied === "link" ? "链接已复制" : "复制链接"}
          </button>
        </div>
      </section>
    </div>
  );
}

function BoardModal({
  round,
  board,
  sacrificeTarget,
  deathTarget,
  roundReveal,
  players,
  onClose
}: {
  round: number;
  board: StatePayload["public"]["board"];
  sacrificeTarget: number;
  deathTarget: number;
  roundReveal: PublicCard[];
  players: PublicPlayer[];
  onClose: () => void;
}) {
  const playerById = (id?: string) => players.find((player) => player.id === id);
  const deathCount = board.death.filter(
    (card) => card.type === "believer" || card.type === "bishop"
  ).length;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal board-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">第 {round || 0} 轮</p>
            <h2>主版图</h2>
          </div>
          <button className="text-button" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="board-panel">
          <div className="board-grid">
            <BoardZone title="圣所" cards={board.sanctuary} />
            <BoardZone title={`献祭 ${board.sacrifice.length}/${sacrificeTarget}`} cards={board.sacrifice} />
            <BoardZone title={`死亡 ${deathCount}/${deathTarget}`} cards={board.death} />
          </div>
          {roundReveal.length > 0 && (
            <div className="round-reveal">
              <h3>本轮公开</h3>
              <div className="card-row">
                {roundReveal.map((card) => {
                  const owner = card.ownerId ? playerById(card.ownerId) : undefined;
                  return (
                    <div className={`mini-card ${cardTone(card.type)}`} key={card.id}>
                      <strong>{CARD_NAMES[card.type]}</strong>
                      {owner && (
                        <small className="card-owner">
                          <span className="owner-seat">{owner.seat}号玩家</span>
                          <span className="owner-name">{owner.nickname}</span>
                        </small>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function RoundSummary({
  entry,
  players
}: {
  entry: RoundHistoryEntry;
  players: PublicPlayer[];
}) {
  const playerById = (id?: string) => players.find((player) => player.id === id);
  const holder = playerById(entry.coinHolderId) ?? playerById(entry.crystal?.ownerId);
  const holderLabel = holder ? playerLabel(holder) : entry.coinHolderId ? "未知玩家" : "未记录";
  const plays = entry.plays ?? [];
  return (
    <>
      <dl className="history-facts">
        <div>
          <dt>金币持有者</dt>
          <dd>{holderLabel}</dd>
        </div>
        <div>
          <dt>发动水晶</dt>
          <dd>
            {entry.crystal ? crystalSkillLabel(entry.crystal.number, entry.crystal.name) : "未记录"}
          </dd>
        </div>
        <div>
          <dt>技能效果</dt>
          <dd>{entry.crystal?.description ?? "未记录"}</dd>
        </div>
      </dl>
      <h3>出牌记录</h3>
      <ul className="history-plays">
        {plays.length === 0 ? (
          <li className="muted">没有出牌记录</li>
        ) : (
          plays.map((play) => {
            const ownedCard = entry.cards.find((card) => card.ownerId === play.playerId);
            return (
              <li key={play.playerId}>
                <strong>
                  {playerLabel(play)}
                </strong>
                <span>
                  {play.action === "passed"
                    ? "跳过"
                    : ownedCard
                      ? `打出了【${CARD_NAMES[ownedCard.type]}】`
                      : "出牌"}
                </span>
              </li>
            );
          })
        )}
      </ul>
      <h3>公开的牌</h3>
      <div className="card-row">
        {entry.cards.length === 0 ? (
          <span className="muted">本轮无人出牌</span>
        ) : (
          entry.cards.map((card) => {
            const cardOwner = card.ownerId ? playerById(card.ownerId) : undefined;
            return (
              <div className={`mini-card ${cardTone(card.type)}`} key={card.id}>
                <strong>{CARD_NAMES[card.type]}</strong>
                <small>
                  {zoneName(card.zone)}
                  {cardOwner ? ` · ${playerLabel(cardOwner)}` : ""}
                </small>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function RoundHistory({
  entries,
  players,
  onClose
}: {
  entries: RoundHistoryEntry[];
  players: PublicPlayer[];
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>历史轮次</h2>
          <button className="text-button" onClick={onClose}>
            关闭
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="muted">还没有已经结算的轮次</p>
        ) : (
          <div className="history-list">
            {[...entries].reverse().map((entry) => (
              <article key={entry.round} className="history-round">
                <p className="eyebrow">第 {entry.round} 轮</p>
                <RoundSummary entry={entry} players={players} />
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RoundResultModal({
  entry,
  players,
  onClose
}: {
  entry: RoundHistoryEntry;
  players: PublicPlayer[];
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop result-overlay" onClick={onClose}>
      <section className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">第 {entry.round} 轮</p>
            <h2>本轮公开结果</h2>
          </div>
          <button className="text-button" onClick={onClose}>
            关闭
          </button>
        </div>
        <RoundSummary entry={entry} players={players} />
        <button className="result-dismiss" onClick={onClose}>
          知道了
        </button>
      </section>
    </div>
  );
}

function WinnerModal({
  winner,
  message,
  players,
  isHost,
  busy,
  onNewGame,
  onClose
}: {
  winner?: Faction | "aborted";
  message: string;
  players: PublicPlayer[];
  isHost: boolean;
  busy: boolean;
  onNewGame: () => void;
  onClose: () => void;
}) {
  const title =
    winner === "rose" ? "白蔷薇阵营获胜" : winner === "blade" ? "血刃阵营获胜" : "本局提前结束";
  return (
    <div className="modal-backdrop result-overlay" onClick={onClose}>
      <section className="modal winner-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="text-button" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="winner-message">{message}</p>
        <h3>身份公开</h3>
        <ul className="role-reveal-list">
          {players.map((player) => (
            <li key={player.id}>
              <strong>{playerLabel(player)}</strong>
              <span className={player.role ? factionForRole(player.role) : ""}>
                {player.role ? ROLE_NAMES[player.role] : "未知"}
              </span>
            </li>
          ))}
        </ul>
        <div className="button-row play-confirm-row">
          {isHost && (
            <button disabled={busy} onClick={onNewGame}>
              准备下一局
            </button>
          )}
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </section>
    </div>
  );
}

function EndVoteModal({
  proposer,
  votes,
  needed,
  players,
  hasCast,
  agreed,
  busy,
  onAgree,
  onReject,
  onClose
}: {
  proposer?: PublicPlayer;
  votes: number;
  needed: number;
  players: PublicPlayer[];
  hasCast: boolean;
  agreed: boolean;
  busy: boolean;
  onAgree: () => void;
  onReject: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop end-vote-overlay"
      onClick={hasCast ? onClose : undefined}
    >
      <section className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>提前结束本局？</h2>
          {hasCast && (
            <button className="text-button" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
        <p className="winner-message">
          {proposer ? `${playerLabel(proposer)} 发起投票` : "有玩家发起投票"}
          ，需要 {needed} 人同意才会结束。
        </p>
        <p className="end-vote-tally">
          当前同意 {votes}/{needed}
        </p>
        <ul className="history-plays">
          {players.map((player) => (
            <li key={player.id}>
              <strong>{playerLabel(player)}</strong>
              <span>
                {player.endVoteCast ? (player.endVote ? "同意结束" : "选择继续") : "未投票"}
              </span>
            </li>
          ))}
        </ul>
        {hasCast ? (
          <p className="must-play-hint">{agreed ? "你已同意提前结束" : "你已拒绝提前结束"}</p>
        ) : (
          <div className="button-row play-confirm-row">
            <button disabled={busy} onClick={onAgree}>
              同意结束
            </button>
            <button className="secondary" disabled={busy} onClick={onReject}>
              继续游戏
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function CrystalGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>全部水晶能力</h2>
          <button className="text-button" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="crystal-list">
          {Object.entries(CRYSTALS).map(([number, crystal]) => (
            <article key={number}>
              <strong>
                {crystalSkillLabel(Number(number), crystal.name)}
              </strong>
              <p>{crystal.description}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function zoneName(zone: PrivateCard["zone"]): string {
  const names: Record<PrivateCard["zone"], string> = {
    hand: "未使用",
    pending: "本轮暗牌",
    sacrifice: "已献祭",
    death: "死亡区",
    sanctuary: "圣所",
    removed: "已移除"
  };
  return names[zone];
}

export default App;
