/**
 * 围棋核心规则与棋盘状态引擎 (Go Game Engine)
 * 支持 19x19 / 13x13 / 9x9 棋盘，中国规则（数子法，默认贴 7.5 目）：
 * 严格算气、提子、禁自杀、打劫禁着、禁全同（位置超级劫）、
 * 终局死子判定与数子、形势判断与 SGF 导入导出。
 */

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

/**
 * 实时形势估计的阈值：面积不超过这个值的空域，直接当作已经成型的眼位或小片实地。
 * 名字与 go_ai.js 中的 SETTLED_REGION_MAX 区分开，避免两个脚本在同一全局作用域重复声明常量。
 */
const ESTIMATE_SETTLED_REGION_MAX = 12;

/**
 * Zobrist 校验表：用于「禁全同」判定，按棋盘规格缓存。
 * 使用确定性伪随机，保证同一局面校验值稳定、可复现。
 */
let ZOBRIST_CACHE = { size: 0, lo: null, hi: null };
function getZobrist(size) {
  if (ZOBRIST_CACHE.size === size) return ZOBRIST_CACHE;
  let seed = (0x9e3779b9 ^ (size * 2654435761)) >>> 0;
  const next = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed;
  };
  const n = size * size * 3;
  const lo = new Int32Array(n);
  const hi = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    lo[i] = next() | 0;
    hi[i] = next() | 0;
  }
  ZOBRIST_CACHE = { size, lo, hi };
  return ZOBRIST_CACHE;
}

class GoEngine {
  constructor(size = 19, komi = 7.5) {
    this.size = size;
    this.komi = komi;
    this.reset();
  }

  reset() {
    this.board = new Uint8Array(this.size * this.size);
    this.turn = BLACK;
    this.history = []; // Array of { board, move: {x, y, color}, captures, koPoint, zHash }
    this.captures = { black: 0, white: 0 };
    this.consecutivePasses = 0;
    this.isGameOver = false;
    this.awaitingSettlement = false; // 双方停一手后，等待终局数子确认
    this.koPoint = null; // 打劫禁着点 (1D index)
    this.winner = null;
    this.scoreResult = null;
    this.deadStones = new Set(); // 终局被判定/标记为死子的位置
    this.lastLoadReport = null;
    this.zTable = getZobrist(this.size);
    this.zHash = { lo: 0, hi: 0 };
    this.positionSet = new Set([this._positionKey(this.zHash)]);
    this._visit = null;
    this._visitStamp = 0;
  }

  /** 对局是否已经不能再落子（终局或等待数子） */
  get finished() {
    return this.isGameOver || this.awaitingSettlement;
  }

  clone() {
    const next = new GoEngine(this.size, this.komi);
    next.board = new Uint8Array(this.board);
    next.turn = this.turn;
    next.captures = { ...this.captures };
    next.consecutivePasses = this.consecutivePasses;
    next.isGameOver = this.isGameOver;
    next.awaitingSettlement = this.awaitingSettlement;
    next.koPoint = this.koPoint;
    next.winner = this.winner;
    next.scoreResult = this.scoreResult;
    next.deadStones = new Set(this.deadStones);
    next.zTable = this.zTable;
    next.zHash = { ...this.zHash };
    next.positionSet = new Set(this.positionSet);
    next.history = this.history.map(h => ({
      board: new Uint8Array(h.board),
      move: { ...h.move },
      captures: { ...h.captures },
      koPoint: h.koPoint,
      zHash: { ...h.zHash },
      posKeyAfter: h.posKeyAfter
    }));
    return next;
  }

  /**
   * 用外部快照恢复局面（供 Web Worker / 复盘使用）
   * 会按着法顺序重放，保证气数、提子、打劫点与禁全同校验值全部一致。
   */
  restore(snapshot = {}) {
    this.reset();
    const replayHistory = Array.isArray(snapshot.history) && snapshot.history.length > 0;
    // 有完整着法记录时从空盘重放，避免「先摆最终局面、再重放全部着法」造成重复落子
    if (snapshot.board && !replayHistory) {
      this.board = new Uint8Array(snapshot.board);
      this.recomputeHash();
      this.positionSet = new Set([this._positionKey(this.zHash)]);
    }
    this.turn = snapshot.turn || BLACK;
    if (snapshot.captures) this.captures = { ...this.captures, ...snapshot.captures };
    if (snapshot.koPoint !== undefined) this.koPoint = snapshot.koPoint;

    if (replayHistory) {
      for (const h of snapshot.history) {
        if (!h || !h.move) continue;
        if (h.move.x === -1 && h.move.y === -1) this.pass(h.move.color);
        else this.play(h.move.x, h.move.y, h.move.color);
      }
      if (snapshot.turn) this.turn = snapshot.turn;
    }
    return this;
  }

  coordToIndex(x, y) {
    return y * this.size + x;
  }

  indexToCoord(idx) {
    return {
      x: idx % this.size,
      y: Math.floor(idx / this.size)
    };
  }

  isOnBoard(x, y) {
    return x >= 0 && x < this.size && y >= 0 && y < this.size;
  }

  get(x, y) {
    if (!this.isOnBoard(x, y)) return null;
    return this.board[this.coordToIndex(x, y)];
  }

  getNeighbors(x, y) {
    const res = [];
    if (x > 0) res.push({ x: x - 1, y, idx: this.coordToIndex(x - 1, y) });
    if (x < this.size - 1) res.push({ x: x + 1, y, idx: this.coordToIndex(x + 1, y) });
    if (y > 0) res.push({ x, y: y - 1, idx: this.coordToIndex(x, y - 1) });
    if (y < this.size - 1) res.push({ x, y: y + 1, idx: this.coordToIndex(x, y + 1) });
    return res;
  }

  getDiagonalNeighbors(x, y) {
    const res = [];
    if (x > 0 && y > 0) res.push({ x: x - 1, y: y - 1, idx: this.coordToIndex(x - 1, y - 1) });
    if (x < this.size - 1 && y > 0) res.push({ x: x + 1, y: y - 1, idx: this.coordToIndex(x + 1, y - 1) });
    if (x > 0 && y < this.size - 1) res.push({ x: x - 1, y: y + 1, idx: this.coordToIndex(x - 1, y + 1) });
    if (x < this.size - 1 && y < this.size - 1) res.push({ x: x + 1, y: y + 1, idx: this.coordToIndex(x + 1, y + 1) });
    return res;
  }

  neighborIdx(idx) {
    const x = idx % this.size;
    const y = (idx - x) / this.size;
    const res = [];
    if (x > 0) res.push(idx - 1);
    if (x < this.size - 1) res.push(idx + 1);
    if (y > 0) res.push(idx - this.size);
    if (y < this.size - 1) res.push(idx + this.size);
    return res;
  }

  /**
   * 获取某位置所在棋块（字符串）的全部棋子及其所有的气（liberties）
   * 使用代次标记复用缓冲区，避免反复分配大数组。
   */
  getString(startX, startY) {
    const total = this.size * this.size;
    const startIdx = this.coordToIndex(startX, startY);
    const color = this.board[startIdx];
    if (color === EMPTY) {
      return { color: EMPTY, stones: [], liberties: [] };
    }

    if (!this._visit || this._visit.length !== total) {
      this._visit = new Int32Array(total);
      this._visitStamp = 0;
    }
    const stamp = ++this._visitStamp;
    const visit = this._visit;

    const stones = [];
    const liberties = new Set();
    const queue = [startIdx];
    visit[startIdx] = stamp;

    while (queue.length > 0) {
      const curIdx = queue.pop();
      stones.push(curIdx);
      const cx = curIdx % this.size;
      const cy = (curIdx - cx) / this.size;

      for (const n of this.getNeighbors(cx, cy)) {
        const nColor = this.board[n.idx];
        if (nColor === EMPTY) {
          liberties.add(n.idx);
        } else if (nColor === color && visit[n.idx] !== stamp) {
          visit[n.idx] = stamp;
          queue.push(n.idx);
        }
      }
    }

    return {
      color,
      stones,
      liberties: Array.from(liberties)
    };
  }

  /* ---------------- 禁全同（位置超级劫）支持 ---------------- */

  _positionKey(hash) {
    return hash.lo + ":" + hash.hi;
  }

  _xorStone(hash, idx, color) {
    const k = idx * 3 + color;
    hash.lo ^= this.zTable.lo[k];
    hash.hi ^= this.zTable.hi[k];
  }

  recomputeHash() {
    this.zTable = getZobrist(this.size);
    this.zHash = { lo: 0, hi: 0 };
    for (let i = 0; i < this.board.length; i++) {
      const c = this.board[i];
      if (c !== EMPTY) this._xorStone(this.zHash, i, c);
    }
    return this.zHash;
  }

  /**
   * 检验落子合法性（返回 { legal, reason?, capturedStones? }）
   */
  checkMoveLegality(x, y, color = this.turn) {
    if (this.finished) {
      return { legal: false, reason: this.isGameOver ? "对局已结束" : "等待终局数子" };
    }
    if (!this.isOnBoard(x, y)) {
      return { legal: false, reason: "越界" };
    }
    const idx = this.coordToIndex(x, y);
    if (this.board[idx] !== EMPTY) {
      return { legal: false, reason: "此位置已有棋子" };
    }

    // 检查打劫禁着点（单劫即时反提）
    if (this.koPoint === idx) {
      return { legal: false, reason: "打劫禁着（需先找劫材）" };
    }

    const opponent = 3 - color;
    const neighbors = this.getNeighbors(x, y);

    // 假设在此落子
    this.board[idx] = color;

    // 检查是否提掉对方棋子
    const capturedStones = [];
    const checkedOpponentRoots = new Set();

    for (const n of neighbors) {
      if (this.board[n.idx] === opponent && !checkedOpponentRoots.has(n.idx)) {
        const oppGroup = this.getString(n.x, n.y);
        for (const s of oppGroup.stones) checkedOpponentRoots.add(s);
        if (oppGroup.liberties.length === 0) {
          capturedStones.push(...oppGroup.stones);
        }
      }
    }

    let legal = true;
    let reason = null;

    if (capturedStones.length === 0) {
      // 检查己方是否有气（禁自杀）
      const myGroup = this.getString(x, y);
      if (myGroup.liberties.length === 0) {
        legal = false;
        reason = "禁止自杀";
      }
    } else {
      // 禁全同：只有发生提子的着手才可能复原此前出现过的全盘局面
      const next = { lo: this.zHash.lo, hi: this.zHash.hi };
      this._xorStone(next, idx, color);
      for (const c of capturedStones) this._xorStone(next, c, opponent);
      if (this.positionSet.has(this._positionKey(next))) {
        legal = false;
        reason = "禁全同（此手会复原先前局面）";
      }
    }

    // 还原棋盘
    this.board[idx] = EMPTY;

    return { legal, reason, capturedStones };
  }

  /**
   * 执行落子
   */
  play(x, y, color = this.turn) {
    const check = this.checkMoveLegality(x, y, color);
    if (!check.legal) {
      return { success: false, reason: check.reason };
    }

    const idx = this.coordToIndex(x, y);
    const captured = check.capturedStones || [];

    // 保存历史记录以供悔棋与复局
    this.history.push({
      board: new Uint8Array(this.board),
      move: { x, y, color },
      captures: { ...this.captures },
      koPoint: this.koPoint,
      zHash: { ...this.zHash }
    });

    // 落下棋子
    this.board[idx] = color;
    this._xorStone(this.zHash, idx, color);

    // 提掉死子
    for (const cIdx of captured) {
      this.board[cIdx] = EMPTY;
      this._xorStone(this.zHash, cIdx, opponent(color));
    }

    this.history[this.history.length - 1].posKeyAfter = this._positionKey(this.zHash);
    this.positionSet.add(this.history[this.history.length - 1].posKeyAfter);

    if (color === BLACK) {
      this.captures.black += captured.length;
    } else {
      this.captures.white += captured.length;
    }

    // 更新打劫禁点：恰提一子且自身仅剩一气时，对方不可立即反提
    if (captured.length === 1) {
      const myGroup = this.getString(x, y);
      if (myGroup.stones.length === 1 && myGroup.liberties.length === 1) {
        this.koPoint = captured[0];
      } else {
        this.koPoint = null;
      }
    } else {
      this.koPoint = null;
    }

    this.consecutivePasses = 0;
    this.turn = 3 - color;

    return {
      success: true,
      capturedCount: captured.length,
      capturedStones: captured
    };
  }

  /**
   * 停一手 (Pass)
   * 双方连续停一手后进入终局数子阶段（awaitingSettlement），
   * 需要调用 settle() 确认死子后才会真正结束并判定胜负。
   */
  pass(color = this.turn) {
    if (this.finished) {
      return { success: false, reason: "对局已结束" };
    }

    this.history.push({
      board: new Uint8Array(this.board),
      move: { x: -1, y: -1, color },
      captures: { ...this.captures },
      koPoint: this.koPoint,
      zHash: { ...this.zHash }
    });

    this.koPoint = null;
    this.consecutivePasses++;
    this.turn = 3 - color;

    if (this.consecutivePasses >= 2) {
      this.awaitingSettlement = true;
    }

    return {
      success: true,
      isGameOver: this.isGameOver,
      awaitingSettlement: this.awaitingSettlement,
      scoreResult: this.awaitingSettlement ? this.finalScore(this.getSuggestedDeadStones()) : null
    };
  }

  /**
   * 认输 (Resign)
   */
  resign(color = this.turn) {
    if (this.isGameOver) return { success: false };
    this.isGameOver = true;
    this.awaitingSettlement = false;
    this.winner = 3 - color;
    this.scoreResult = {
      winner: this.winner,
      loser: color,
      margin: "认输",
      blackStones: 0,
      whiteStones: 0,
      blackTerritory: 0,
      whiteTerritory: 0,
      blackTotal: 0,
      whiteTotal: 0,
      komi: this.komi,
      territory: new Int8Array(this.size * this.size),
      deadStones: []
    };
    return { success: true, winner: this.winner };
  }

  /**
   * 从终局数子阶段返回对局（双方停一手后仍要继续下）
   */
  resumePlay() {
    if (this.isGameOver) return false;
    this.awaitingSettlement = false;
    this.consecutivePasses = 0;
    this.winner = null;
    this.scoreResult = null;
    return true;
  }

  /**
   * 悔棋 (Undo)
   */
  undo() {
    if (this.history.length === 0) return false;
    const last = this.history.pop();
    this.board = last.board;
    this.captures = last.captures;
    this.koPoint = last.koPoint;
    this.turn = last.move.color;
    if (last.zHash) this.zHash = { ...last.zHash };
    if (last.posKeyAfter) this.positionSet.delete(last.posKeyAfter);
    this.consecutivePasses = 0;
    this.isGameOver = false;
    this.awaitingSettlement = false;
    this.deadStones = new Set();
    this.winner = null;
    this.scoreResult = null;
    return true;
  }

  /**
   * 获取所有合法落子点
   */
  getLegalMoves(color = this.turn) {
    const legalMoves = [];
    if (this.finished) return legalMoves;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.board[this.coordToIndex(x, y)] === EMPTY) {
          const res = this.checkMoveLegality(x, y, color);
          if (res.legal) {
            legalMoves.push({ x, y, capturedCount: res.capturedStones.length });
          }
        }
      }
    }
    return legalMoves;
  }

  /* ---------------- 形势判断与数子 ---------------- */

  /**
   * 中国规则：子空皆地（Area Scoring）+ 泛洪填充形式判断
   */
  calculateAreaScore() {
    return this.scoreBoard(this.board);
  }

  /**
   * 对局进行中的形势估计：与 calculateAreaScore 用的是同一套数子规则，
   * 区别是只把「已经成型」的空域计入地盘，避免空盘或开局阶段把整片空旷区域
   * 判给一方。终局数子请继续使用 calculateAreaScore / finalScore（严格数子）。
   */
  estimateScore() {
    return this.scoreBoard(this.board, { strictBorder: true });
  }

  scoreBoard(board, options = {}) {
    // strictBorder = true 时，面积大而边界棋子稀疏的空域不判归属（见 estimateScore）
    const strictBorder = options.strictBorder === true;
    const N = this.size;
    const totalPoints = N * N;
    const territory = new Int8Array(totalPoints); // 1 = Black, 2 = White, 0 = Dame/Neutral
    const visited = new Uint8Array(totalPoints);

    let blackStones = 0;
    let whiteStones = 0;

    for (let i = 0; i < totalPoints; i++) {
      if (board[i] === BLACK) blackStones++;
      else if (board[i] === WHITE) whiteStones++;
    }

    // 泛洪填充空白空域
    for (let i = 0; i < totalPoints; i++) {
      if (board[i] !== EMPTY || visited[i]) continue;

      const group = [];
      const queue = [i];
      visited[i] = 1;
      let touchesBlack = false;
      let touchesWhite = false;
      const borderStones = strictBorder ? new Set() : null;

      while (queue.length > 0) {
        const cur = queue.pop();
        group.push(cur);
        const cx = cur % N;
        const cy = Math.floor(cur / N);

        for (const n of this.getNeighbors(cx, cy)) {
          const nColor = board[n.idx];
          if (nColor === BLACK) {
            touchesBlack = true;
            if (strictBorder) borderStones.add(n.idx);
          } else if (nColor === WHITE) {
            touchesWhite = true;
            if (strictBorder) borderStones.add(n.idx);
          } else if (nColor === EMPTY && !visited[n.idx]) {
            visited[n.idx] = 1;
            queue.push(n.idx);
          }
        }
      }

      let owner = 0;
      if (touchesBlack && !touchesWhite) owner = BLACK;
      else if (touchesWhite && !touchesBlack) owner = WHITE;

      // 空盘或刚开局时，整块空点也会「只与一方相邻」，纯按数子法会把它整片判给该方，
      // 显示成「领先三百余目」。这里要求空域要么足够小（眼位／小片实地），
      // 要么四周棋子足够密，才算作已经定型的实地。
      if (owner !== 0 && strictBorder) {
        const regionSize = group.length;
        const settled = regionSize <= ESTIMATE_SETTLED_REGION_MAX || borderStones.size * 2 >= regionSize;
        if (!settled) owner = 0;
      }

      for (const idx of group) {
        territory[idx] = owner;
      }
    }

    let blackTerritory = 0;
    let whiteTerritory = 0;

    for (let i = 0; i < totalPoints; i++) {
      if (territory[i] === BLACK) blackTerritory++;
      else if (territory[i] === WHITE) whiteTerritory++;
    }

    const blackArea = blackStones + blackTerritory;
    const whiteArea = whiteStones + whiteTerritory + this.komi;

    let winner = null;
    let margin = "0.0";

    if (blackArea > whiteArea) {
      winner = BLACK;
      margin = (blackArea - whiteArea).toFixed(1);
    } else if (whiteArea > blackArea) {
      winner = WHITE;
      margin = (whiteArea - blackArea).toFixed(1);
    }

    return {
      winner,
      margin,
      blackStones,
      whiteStones,
      blackTerritory,
      whiteTerritory,
      blackTotal: blackArea,
      whiteTotal: whiteArea,
      komi: this.komi,
      territory
    };
  }

  /**
   * 终局数子：在移除指定死子后的局面上重新计算子空
   */
  finalScore(deadStones) {
    const dead = deadStones instanceof Set ? deadStones : new Set(deadStones || []);
    const scratch = new Uint8Array(this.board);
    for (const idx of dead) scratch[idx] = EMPTY;
    const res = this.scoreBoard(scratch);
    res.deadStones = Array.from(dead).sort((a, b) => a - b);
    return res;
  }

  /**
   * 静态局面解析：棋块、空域、连通关系（死子判定内部工具）
   */
  _analyzeBoard(board) {
    const size = this.size;
    const total = size * size;
    const chainId = new Int32Array(total).fill(-1);
    const regionId = new Int32Array(total).fill(-1);
    const chains = [];
    const regions = [];

    for (let i = 0; i < total; i++) {
      if (board[i] === EMPTY || chainId[i] !== -1) continue;
      const color = board[i];
      const id = chains.length;
      const stones = [];
      const liberties = new Set();
      const stack = [i];
      chainId[i] = id;
      while (stack.length > 0) {
        const cur = stack.pop();
        stones.push(cur);
        for (const n of this.neighborIdx(cur)) {
          const v = board[n];
          if (v === EMPTY) liberties.add(n);
          else if (v === color && chainId[n] === -1) {
            chainId[n] = id;
            stack.push(n);
          }
        }
      }
      chains.push({ id, color, stones, liberties });
    }

    for (let i = 0; i < total; i++) {
      if (board[i] !== EMPTY || regionId[i] !== -1) continue;
      const id = regions.length;
      const points = [];
      const adjChains = new Set();
      const stack = [i];
      regionId[i] = id;
      while (stack.length > 0) {
        const cur = stack.pop();
        points.push(cur);
        for (const n of this.neighborIdx(cur)) {
          const v = board[n];
          if (v === EMPTY) {
            if (regionId[n] === -1) {
              regionId[n] = id;
              stack.push(n);
            }
          } else {
            adjChains.add(chainId[n]);
          }
        }
      }
      regions.push({ id, points, adjChains });
    }

    const chainRegions = new Map();
    for (const chain of chains) {
      const set = new Set();
      for (const lib of chain.liberties) set.add(regionId[lib]);
      chainRegions.set(chain.id, set);
    }

    return { chainId, chains, regionId, regions, chainRegions };
  }

  _groupOnBoard(board, startIdx) {
    const color = board[startIdx];
    if (color === EMPTY) return null;
    const stones = [];
    const liberties = new Set();
    const seen = new Set([startIdx]);
    const stack = [startIdx];
    while (stack.length > 0) {
      const cur = stack.pop();
      stones.push(cur);
      for (const n of this.neighborIdx(cur)) {
        const v = board[n];
        if (v === EMPTY) liberties.add(n);
        else if (v === color && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    return { color, stones, liberties: Array.from(liberties) };
  }

  /**
   * 试下：在快照棋盘上落子，按「先提子、后算气」判定是否为合法着手
   * 返回 { ok, captured }，ok 为 false 时表示该点不可落（禁自杀）
   */
  _fillOnBoard(board, idx, color) {
    const opponent = 3 - color;
    board[idx] = color;
    const captured = [];
    const seen = new Set();
    for (const n of this.neighborIdx(idx)) {
      if (board[n] === opponent && !seen.has(n)) {
        const g = this._groupOnBoard(board, n);
        if (g) {
          for (const s of g.stones) seen.add(s);
          if (g.liberties.length === 0) captured.push(...g.stones);
        }
      }
    }
    if (captured.length > 0) {
      for (const c of captured) board[c] = EMPTY;
      return { ok: true, captured: captured.length };
    }
    const mine = this._groupOnBoard(board, idx);
    if (!mine || mine.liberties.length === 0) {
      board[idx] = EMPTY;
      return { ok: false, captured: 0 };
    }
    return { ok: true, captured: 0 };
  }

  /** 安全收气：落子后自身棋块仍保有 minLiberties 口气，否则回滚 */
  _fillKeepingLiberties(board, idx, color, minLiberties) {
    const trial = new Uint8Array(board);
    if (!this._fillOnBoard(trial, idx, color).ok) return false;
    const mine = this._groupOnBoard(trial, idx);
    if (!mine || mine.liberties.length < minLiberties) return false;
    board.set(trial);
    return true;
  }

  /** 提子收气：仅在该手能立即提掉对方时落子，否则回滚 */
  _fillCapturing(board, idx, color) {
    const trial = new Uint8Array(board);
    const res = this._fillOnBoard(trial, idx, color);
    if (!res.ok || res.captured === 0) return false;
    board.set(trial);
    return true;
  }

  /**
   * Benson 死活定理：判定「无条件活棋」的棋块集合
   */
  _bensonAlive(analysis) {
    const alive = new Set();
    for (const color of [BLACK, WHITE]) {
      let X = new Set(analysis.chains.filter(c => c.color === color).map(c => c.id));
      if (X.size === 0) continue;

      let R = new Set();
      for (const region of analysis.regions) {
        if (region.adjChains.size === 0) continue;
        let onlyMine = true;
        for (const cid of region.adjChains) {
          if (analysis.chains[cid].color !== color) {
            onlyMine = false;
            break;
          }
        }
        if (onlyMine) R.add(region.id);
      }

      for (let guard = 0; guard < 64; guard++) {
        const nextX = new Set();
        for (const cid of X) {
          let count = 0;
          const touched = analysis.chainRegions.get(cid) || new Set();
          for (const rid of touched) {
            if (R.has(rid)) {
              count++;
              if (count >= 2) break;
            }
          }
          if (count >= 2) nextX.add(cid);
        }
        const nextR = new Set();
        for (const rid of R) {
          const region = analysis.regions[rid];
          let ok = true;
          for (const cid of region.adjChains) {
            if (!nextX.has(cid)) {
              ok = false;
              break;
            }
          }
          if (ok) nextR.add(rid);
        }
        const stable = nextX.size === X.size && nextR.size === R.size;
        X = nextX;
        R = nextR;
        if (stable) break;
      }

      for (const cid of X) alive.add(cid);
    }
    return alive;
  }

  /**
   * 该棋块是否具备做眼潜力：
   * - 拥有两个以上「自家空域」（只与己方棋块相接的空点区域）；或
   * - 存在一个不少于 3 点的自家空域（足以在内部做出双眼）。
   * 1~2 点的单眼空间不足以做活，交由收气试吃判定。
   */
  _chainEyePotential(analysis, chain) {
    const regions = analysis.chainRegions.get(chain.id);
    if (!regions) return false;
    const ownSizes = [];
    for (const rid of regions) {
      const region = analysis.regions[rid];
      if (region.adjChains.size === 0) continue;
      let own = true;
      for (const cid of region.adjChains) {
        if (analysis.chains[cid].color !== chain.color) {
          own = false;
          break;
        }
      }
      if (own) ownSizes.push(region.points.length);
    }
    if (ownSizes.length >= 2) return true;
    return ownSizes.some(size => size >= 3);
  }

  /**
   * 依次收气试吃：对方能否把这块棋的每一口气都安全填上。
   * 只认可「安全收气」（收气方自身保持 2 气以上）；
   * 若只能靠贴气对杀，则视为对杀或公活，一律判活（保守，宁可留活不给错判死）。
   */
  _canBeCapturedByFilling(board, chain) {
    const work = new Uint8Array(board);
    const color = chain.color;
    const opponent = 3 - color;
    for (let guard = 0; guard < 600; guard++) {
      const group = this._groupOnBoard(work, chain.stones[0]);
      if (!group || group.color !== color) return true;

      let safeFilled = false;
      for (const lib of group.liberties) {
        if (this._fillKeepingLiberties(work, lib, opponent, 2)) {
          safeFilled = true;
          break;
        }
      }
      if (safeFilled) continue;

      // 没有安全收气点：只有能立即提掉才算死，否则视为对杀 / 公活
      for (const lib of group.liberties) {
        if (this._fillCapturing(work, lib, opponent)) return true;
      }
      return false;
    }
    return false;
  }

  /**
   * 自动判定死子：Benson 活棋与其有眼位空间的棋块一律判活（保守），
   * 只把「无眼位空间且可被对方收气提掉」的棋块标为死子。
   * 结果仅作为终局数子的参考，最终由使用者确认。
   */
  getSuggestedDeadStones() {
    const dead = new Set();
    for (let round = 0; round < 4; round++) {
      const board = new Uint8Array(this.board);
      for (const idx of dead) board[idx] = EMPTY;
      const analysis = this._analyzeBoard(board);
      const alive = this._bensonAlive(analysis);
      let changed = false;
      for (const chain of analysis.chains) {
        if (alive.has(chain.id)) continue;
        if (this._chainEyePotential(analysis, chain)) continue;
        if (!this._canBeCapturedByFilling(board, chain)) continue;
        for (const stone of chain.stones) {
          if (!dead.has(stone)) {
            dead.add(stone);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    return dead;
  }

  /**
   * 确认终局：提掉死子并完成数子判定
   */
  settle(deadStones) {
    const dead = deadStones instanceof Set ? new Set(deadStones) : new Set(deadStones || []);
    const result = this.finalScore(dead);
    for (const idx of dead) this.board[idx] = EMPTY;
    this.recomputeHash();
    this.deadStones = dead;
    this.isGameOver = true;
    this.awaitingSettlement = false;
    this.scoreResult = result;
    this.winner = result.winner;
    return result;
  }

  /**
   * 导出标准 SGF (Smart Game Format) 文本
   */
  toSGF(blackName = "人类棋手", whiteName = "墨月高阶AI") {
    let sgf = `(;GM[1]FF[4]CA[UTF-8]AP[MoyueGoEngine:1.1]SZ[${this.size}]KM[${this.komi}]RU[Chinese]PW[${whiteName}]PB[${blackName}]`;
    if (this.winner) {
      const winStr = this.winner === BLACK ? "B" : "W";
      const marginStr = typeof this.scoreResult?.margin === "string" && this.scoreResult.margin.includes("认输")
        ? "+R"
        : `+${this.scoreResult?.margin || "0.5"}`;
      sgf += `RE[${winStr}${marginStr}]`;
    }

    const charMap = "abcdefghijklmnopqrstuvwxyz";

    for (const h of this.history) {
      const cStr = h.move.color === BLACK ? "B" : "W";
      if (h.move.x === -1 && h.move.y === -1) {
        sgf += `;${cStr}[]`;
      } else {
        const xC = charMap[h.move.x];
        const yC = charMap[h.move.y];
        sgf += `;${cStr}[${xC}${yC}]`;
      }
    }

    if (this.deadStones && this.deadStones.size > 0) {
      const ae = Array.from(this.deadStones)
        .sort((a, b) => a - b)
        .map(idx => {
          const c = this.indexToCoord(idx);
          return `${charMap[c.x]}${charMap[c.y]}`;
        })
        .join("");
      sgf += `AE[${ae}]`;
    }

    sgf += ")";
    return sgf;
  }

  /**
   * 导入并回放 SGF 文本
   */
  loadSGF(sgfText) {
    this.reset();
    const report = { total: 0, played: 0, skipped: 0, reasons: [] };

    const sizeMatch = /SZ\[(\d+)\]/.exec(sgfText);
    if (sizeMatch) {
      const sz = parseInt(sizeMatch[1], 10);
      if (sz > 0 && sz !== this.size) {
        this.size = sz;
        this.reset();
      }
    }

    const komiMatch = /KM\[([\d.]+)\]/.exec(sgfText);
    if (komiMatch) this.komi = parseFloat(komiMatch[1]);

    const charMap = "abcdefghijklmnopqrstuvwxyz";
    const moveMatches = sgfText.match(/;([BW])\[([a-z]{0,2})\]/gi);
    if (!moveMatches) {
      this.lastLoadReport = report;
      return false;
    }

    for (const m of moveMatches) {
      const match = /;([BW])\[([a-z]{0,2})\]/i.exec(m);
      if (!match) continue;
      const color = match[1].toUpperCase() === "B" ? BLACK : WHITE;
      const coord = match[2].toLowerCase();
      report.total++;

      if (coord.length === 0) {
        const res = this.pass(color);
        if (res.success) report.played++;
        else {
          report.skipped++;
          report.reasons.push(res.reason);
        }
      } else if (coord.length === 2) {
        const x = charMap.indexOf(coord[0]);
        const y = charMap.indexOf(coord[1]);
        if (!this.isOnBoard(x, y)) {
          report.skipped++;
          report.reasons.push(`越界着法 ${coord}`);
          continue;
        }
        const res = this.play(x, y, color);
        if (res.success) report.played++;
        else {
          report.skipped++;
          report.reasons.push(res.reason);
        }
      } else {
        report.skipped++;
      }
    }

    if (this.consecutivePasses >= 2) this.awaitingSettlement = true;
    this.lastLoadReport = report;
    return true;
  }
}

function opponent(color) {
  return 3 - color;
}

// 统一环境导出 (支持 ES/CommonJS/Browser)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { GoEngine, EMPTY, BLACK, WHITE };
}
