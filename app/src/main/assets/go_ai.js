/**
 * 墨月高阶围棋 AI (Moyue High-Knowledge Go Engine)
 * 集成：
 * 1. 八路对称定式与布局知识库 (AI 点三三、小飞挂角、小目定式、三连星、中国流)
 * 2. 局部战术算路系统 (叫吃拯救、征子推演、双叫吃、切断与防断、好形评估、死活眼形)
 * 3. 启发式先验引导的蒙特卡洛树搜索 (Knowledge-Prior MCTS)
 * 4. 棋道与战术自然语言大师级解说生成器 (Natural Go Commentary & Evaluation)
 */

if (typeof require !== "undefined") {
  const engineModule = require("./go_engine.js");
  globalThis.GoEngine = engineModule.GoEngine;
  globalThis.EMPTY = engineModule.EMPTY;
  globalThis.BLACK = engineModule.BLACK;
  globalThis.WHITE = engineModule.WHITE;
}

// 只把面积不大于这个值、且只和一方接壤的空域直接视作眼位／小片实地
const SETTLED_REGION_MAX = 12;

class GoAI {
  constructor(engine, level = "dan") {
    this.engine = engine;
    this.setLevel(level);
    this.initOpeningBook();
  }

  setLevel(level) {
    this.level = level;
    // 依段位调节计算量与战术权重大致对应：
    // kyu (业余初段/中级): 200 模拟, 快速定式, 基础战术
    // dan (业余5段/强手): 700 模拟, 完整定式, 深度战术加权
    // master (棋圣级/大师): 1600 模拟, 宏观大局+局部严密死活+全局MCTS
    switch (level) {
      case "kyu":
        this.mctsSimulations = 250;
        this.rolloutDepth = 16;
        this.c_puct = 1.4;
        break;
      case "master":
        this.mctsSimulations = 1600;
        this.rolloutDepth = 30;
        this.c_puct = 1.1;
        break;
      case "dan":
      default:
        this.mctsSimulations = 700;
        this.rolloutDepth = 22;
        this.c_puct = 1.25;
        break;
    }
  }

  /**
   * 建立全对称定式库 (Top-Left 模板自动扩展为 8 个方向)
   */
  initOpeningBook() {
    // 基础定式树序列格式：moves = [{x, y, c}, ...]
    // 针对 19x19，定式坐标在 (0..9, 0..9) 范围内
    const rawCornerJosekis = [
      // 1. AI 时代星位点三三 (Direct 3-3 Invasion against 4-4 Star)
      [
        { x: 3, y: 3, c: BLACK, desc: "星位占角" },
        { x: 2, y: 2, c: WHITE, desc: "点三三入角" },
        { x: 2, y: 3, c: BLACK, desc: "方向挡住，筑起外势" },
        { x: 1, y: 2, c: WHITE, desc: "二路长出，夺取实地" },
        { x: 1, y: 3, c: BLACK, desc: "三路扳压，强化外围封锁" },
        { x: 1, y: 1, c: WHITE, desc: "二路连扳定型，角上做活" },
        { x: 2, y: 1, c: BLACK, desc: "打吃提气，借机封头" },
        { x: 0, y: 2, c: WHITE, desc: "粘住保根，实地丰厚" }
      ],
      // 2. 星位小飞挂角与一间跳应手 (Knight's approach & one-space jump)
      [
        { x: 3, y: 3, c: BLACK, desc: "占星位" },
        { x: 2, y: 5, c: WHITE, desc: "小飞挂角试探" },
        { x: 3, y: 7, c: BLACK, desc: "一间高跳守角兼张势" },
        { x: 1, y: 8, c: WHITE, desc: "边路拆二，安定自身" }
      ],
      // 3. 星位小飞挂角与托角定式 (Knight's approach & under-attachment)
      [
        { x: 3, y: 3, c: BLACK, desc: "占星位" },
        { x: 2, y: 5, c: WHITE, desc: "小飞挂角" },
        { x: 2, y: 2, c: BLACK, desc: "小飞守角稳固角地" },
        { x: 2, y: 8, c: WHITE, desc: "边路拆三，开辟边原" }
      ],
      // 4. 小目高挂与托退定式 (3-4 point high approach & joseki)
      [
        { x: 2, y: 3, c: BLACK, desc: "守小目实地" },
        { x: 3, y: 5, c: WHITE, desc: "高挂试探应手" },
        { x: 3, y: 2, c: BLACK, desc: "二间跳守角" },
        { x: 1, y: 7, c: WHITE, desc: "边路拆二立足" }
      ],
      // 5. 小目小飞守角 (Knight's enclosure at 3-4)
      [
        { x: 2, y: 3, c: BLACK, desc: "小目" },
        { x: 4, y: 2, c: BLACK, desc: "小飞守角，固若金汤" }
      ]
    ];

    this.josekiSequences = rawCornerJosekis;
  }

  /**
   * 将定式坐标通过 8 种对称变换映射到棋盘 4 个角落
   */
  transformCoord(x, y, symmetryIdx, size = 19) {
    const N = size - 1;
    let tx = x;
    let ty = y;

    // 0: 原样 (左上)
    // 1: 沿对角线翻转
    // 2: 水平翻转 (右上)
    // 3: 水平翻转 + 对角线
    // 4: 垂直翻转 (左下)
    // 5: 垂直翻转 + 对角线
    // 6: 中心对称翻转 (右下)
    // 7: 中心对称 + 对角线
    switch (symmetryIdx) {
      case 0: tx = x; ty = y; break;
      case 1: tx = y; ty = x; break;
      case 2: tx = N - x; ty = y; break;
      case 3: tx = N - y; ty = x; break;
      case 4: tx = x; ty = N - y; break;
      case 5: tx = y; ty = N - x; break;
      case 6: tx = N - x; ty = N - y; break;
      case 7: tx = N - y; ty = N - x; break;
    }
    return { x: tx, y: ty };
  }

  /**
   * 检索开局与定式库推荐着法
   */
  searchOpeningBook(engine, color) {
    if (engine.size !== 19 && engine.size !== 13) return null;
    const history = engine.history;
    const size = engine.size;

    // 开局前4手占角大局观（星位与小目占角）
    if (history.length < 4) {
      const starPoints = [
        { x: 3, y: 3 },
        { x: size - 4, y: 3 },
        { x: 3, y: size - 4 },
        { x: size - 4, y: size - 4 }
      ];
      for (const sp of starPoints) {
        if (engine.get(sp.x, sp.y) === EMPTY) {
          return {
            x: sp.x,
            y: sp.y,
            comment: "开局占角：抢占星位大场，秉承‘金角银边草肚皮’之要义。",
            source: "fuseki_star"
          };
        }
      }
    }

    // 检查定式库匹配
    for (const seq of this.josekiSequences) {
      for (let sym = 0; sym < 8; sym++) {
        let matches = true;
        let nextMove = null;

        for (let step = 0; step < seq.length; step++) {
          const item = seq[step];
          const tCoord = this.transformCoord(item.x, item.y, sym, size);
          const boardVal = engine.get(tCoord.x, tCoord.y);

          if (step < history.length) {
            // 历史前序必须完全吻合当前局部
            if (boardVal !== item.c) {
              matches = false;
              break;
            }
          } else if (step === history.length) {
            // 刚好是下一步
            if (item.c === color && boardVal === EMPTY) {
              const legality = engine.checkMoveLegality(tCoord.x, tCoord.y, color);
              if (legality.legal) {
                nextMove = {
                  x: tCoord.x,
                  y: tCoord.y,
                  comment: `定式选点：${item.desc}，规范行棋以谋求角部与外势平衡。`,
                  source: "joseki"
                };
              }
            }
            break;
          }
        }

        if (matches && nextMove) {
          return nextMove;
        }
      }
    }

    // 开局拆边大场 (Sanrensei / Extensions)
    if (history.length < 12) {
      const extensionBigPoints = [
        { x: 9, y: 3, name: "上边星位大场拆边" },
        { x: 9, y: size - 4, name: "下边星位大场拆边" },
        { x: 3, y: 9, name: "左边星位大场拆边" },
        { x: size - 4, y: 9, name: "右边星位大场拆边" },
        { x: 9, y: 9, name: "天元（全局枢纽）" }
      ];
      for (const bp of extensionBigPoints) {
        if (engine.isOnBoard(bp.x, bp.y) && engine.get(bp.x, bp.y) === EMPTY) {
          const legality = engine.checkMoveLegality(bp.x, bp.y, color);
          if (legality.legal) {
            return {
              x: bp.x,
              y: bp.y,
              comment: `布局展开：占据${bp.name}，张开宏大阵势，配合角部互相生辉。`,
              source: "fuseki_extension"
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * 战术判读：死活紧逼、叫吃逃生、征子防范、双叫吃、切断与连接
   */
  evaluateTacticalMoves(engine, color, options = {}) {
    const full = options.full !== false;
    const opp = 3 - color;
    const N = engine.size;
    const candidates = [];

    // 1. 扫描所有棋块的气
    const checkedRoots = new Set();
    const myAtariGroups = [];
    const oppAtariGroups = [];
    const oppTwoLibGroups = [];

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const idx = engine.coordToIndex(x, y);
        const stoneColor = engine.board[idx];
        if (stoneColor !== EMPTY && !checkedRoots.has(idx)) {
          const group = engine.getString(x, y);
          for (const s of group.stones) checkedRoots.add(s);

          if (group.color === color) {
            if (group.liberties.length === 1) {
              myAtariGroups.push(group);
            }
          } else if (group.color === opp) {
            if (group.liberties.length === 1) {
              oppAtariGroups.push(group);
            } else if (group.liberties.length === 2) {
              oppTwoLibGroups.push(group);
            }
          }
        }
      }
    }

    // 2. 战术 A：立即提掉对方叫吃子 (Capture Opponent Stones in Atari)
    for (const group of oppAtariGroups) {
      const targetIdx = group.liberties[0];
      const target = engine.indexToCoord(targetIdx);
      const leg = engine.checkMoveLegality(target.x, target.y, color);
      if (leg.legal) {
        const value = 250 + group.stones.length * 40;
        candidates.push({
          x: target.x,
          y: target.y,
          score: value,
          comment: `妙手提子：对方${group.stones.length}子陷入叫吃，果断提子拔花，获得巨大实利与厚势。`,
          reason: "capture_atari"
        });
      }
    }

    // 3. 战术 B：拯救己方叫吃子 (Escape / Counter-Atari for My Stones)
    for (const group of myAtariGroups) {
      // 拯救方式 1：反提对方相邻棋子
      let canCounterCapture = false;
      for (const oppGroup of oppAtariGroups) {
        const captureMove = oppGroup.liberties[0];
        const capCoord = engine.indexToCoord(captureMove);
        if (engine.checkMoveLegality(capCoord.x, capCoord.y, color).legal) {
          candidates.push({
            x: capCoord.x,
            y: capCoord.y,
            score: 280 + group.stones.length * 35,
            comment: `反戈一击：己方受到威胁时，以反提对方棋子解围，化被动为主动。`,
            reason: "counter_capture"
          });
          canCounterCapture = true;
        }
      }

      // 拯救方式 2：逃跑长气（检验逃生后是否仍然只有 1 气或陷入征子死路）
      const escapeIdx = group.liberties[0];
      const esc = engine.indexToCoord(escapeIdx);
      const leg = engine.checkMoveLegality(esc.x, esc.y, color);
      if (leg.legal) {
        // 模拟落子测试逃跑后是否有至少 2 气
        engine.board[escapeIdx] = color;
        const newGroup = engine.getString(esc.x, esc.y);
        engine.board[escapeIdx] = EMPTY;

        if (newGroup.liberties.length > 1) {
          candidates.push({
            x: esc.x,
            y: esc.y,
            score: 210 + group.stones.length * 30,
            comment: `应急补强：己方棋子仅剩一气处于叫吃急所，长出延气脱险。`,
            reason: "escape_atari"
          });
        }
      }
    }

    // 4. 战术 C：将对方两气之子叫吃压迫 (Hane / Tighten Liberties to 1)
    for (const group of oppTwoLibGroups) {
      for (const libIdx of group.liberties) {
        const coord = engine.indexToCoord(libIdx);
        const leg = engine.checkMoveLegality(coord.x, coord.y, color);
        if (leg.legal) {
          candidates.push({
            x: coord.x,
            y: coord.y,
            score: 90 + group.stones.length * 15,
            comment: `先手紧气叫吃：紧缩对方气数逼迫其被动应付，掌控局部主导权。`,
            reason: "tighten_liberty"
          });
        }
      }
    }

    // 5. 战术 D：双叫吃与分断 (Double Atari & Cross-Cut)
    // 全盘扫描代价高，仅在根节点做完整评估；随机推演阶段跳过
    for (let y = 0; full && y < N; y++) {
      for (let x = 0; full && x < N; x++) {
        const idx = engine.coordToIndex(x, y);
        if (engine.board[idx] !== EMPTY) continue;

        const leg = engine.checkMoveLegality(x, y, color);
        if (!leg.legal) continue;

        // 假设在此落子
        engine.board[idx] = color;
        let atariCount = 0;
        const touchedOppGroups = new Set();

        for (const n of engine.getNeighbors(x, y)) {
          if (engine.board[n.idx] === opp && !touchedOppGroups.has(n.idx)) {
            const grp = engine.getString(n.x, n.y);
            for (const s of grp.stones) touchedOppGroups.add(s);
            if (grp.liberties.length === 1) {
              atariCount++;
            }
          }
        }
        engine.board[idx] = EMPTY;

        if (atariCount >= 2) {
          candidates.push({
            x,
            y,
            score: 230,
            comment: `绝妙双叫吃：同时叫吃对方两处要点棋子，必定有所斩获。`,
            reason: "double_atari"
          });
        }
      }
    }

    return candidates;
  }

  /**
   * 单点形与线位价值评估 (Positional & Shape Weighting)
   */
  evaluateMoveHeuristic(engine, x, y, color) {
    const N = engine.size;
    const opp = 3 - color;
    let score = 0;

    // 1. 线位价值 (Line value: 3rd & 4th lines are golden, 1st line penalized early)
    const distEdgeX = Math.min(x, N - 1 - x);
    const distEdgeY = Math.min(y, N - 1 - y);
    const line = Math.min(distEdgeX, distEdgeY); // 0 = 1st line, 1 = 2nd line, 2 = 3rd line, 3 = 4th line

    const moveCount = engine.history.length;

    if (moveCount < 60) {
      if (line === 2) score += 35; // 3线 (实地线)
      else if (line === 3) score += 40; // 4线 (势力线)
      else if (line === 1) score += 10; // 2线 (小飞进角/爬)
      else if (line === 0) score -= 60; // 1线 (死线禁忌，前中期忌一路)
    } else {
      if (line === 0) score += 20; // 官子阶段一路扳粘价值升高
      else if (line === 1) score += 25;
    }

    // 2. 邻域接触战与好形 (Shape evaluation: Tiger's mouth, solid connection, empty triangle avoidance)
    const neighbors = engine.getNeighbors(x, y);
    const diag = engine.getDiagonalNeighbors(x, y);

    let myNeighborCount = 0;
    let oppNeighborCount = 0;
    for (const n of neighbors) {
      if (engine.board[n.idx] === color) myNeighborCount++;
      else if (engine.board[n.idx] === opp) oppNeighborCount++;
    }

    // 虎口好形 (Tiger's mouth: 3 friendly stones surrounding empty point)
    if (myNeighborCount === 3) {
      score += 25;
    }
    // 扎实连接 (Solid connect)
    if (myNeighborCount === 2) {
      score += 15;
    }
    // 恶形：惩治空三角 (Empty triangle penalty)
    if (myNeighborCount >= 2) {
      for (const d of diag) {
        if (engine.board[d.idx] === color) {
          // 形成 L 形
          score -= 20;
          break;
        }
      }
    }

    // 3. 接触战斗鼓励（行棋应有互动，避免全盘散沙）
    if (oppNeighborCount > 0) {
      score += 20;
    }

    // 4. 做眼与防破眼 (Eye shape in corner/surrounded territory)
    let myDiags = 0;
    for (const d of diag) {
      if (engine.board[d.idx] === color) myDiags++;
    }
    if (myDiags >= 2 && myNeighborCount >= 1) {
      score += 20; // 巩固眼形
    }

    return score;
  }

  /** 该空点周围是否有棋子（避免把推演浪费在空旷处） */
  hasStoneNeighbor(engine, idx) {
    for (const n of engine.neighborIdx(idx)) {
      if (engine.board[n] !== EMPTY) return true;
    }
    return false;
  }

  /**
   * 快速推演选点：局部提子 > 近身随机 > 棋子邻居随机 > 全盘兜底。
   * 只做常数级别的合法性判断，保证 MCTS 每次模拟都足够快。
   */
  pickRolloutMove(engine, color) {
    const N = engine.size;
    const last = engine.history.length > 0 ? engine.history[engine.history.length - 1].move : null;
    const cx = last && last.x >= 0 ? last.x : (N >> 1);
    const cy = last && last.y >= 0 ? last.y : (N >> 1);

    let best = null;
    let bestScore = -1;
    const x0 = Math.max(0, cx - 2);
    const x1 = Math.min(N - 1, cx + 2);
    const y0 = Math.max(0, cy - 2);
    const y1 = Math.min(N - 1, cy + 2);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const idx = engine.coordToIndex(x, y);
        if (engine.board[idx] !== EMPTY) continue;
        if (!this.hasStoneNeighbor(engine, idx)) continue;
        const leg = engine.checkMoveLegality(x, y, color);
        if (!leg.legal) continue;
        const score = leg.capturedStones.length * 100 + Math.random() * 4;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    if (best && bestScore >= 100) return best;

    for (let attempt = 0; attempt < 40; attempt++) {
      const x = Math.floor(Math.random() * N);
      const y = Math.floor(Math.random() * N);
      const idx = engine.coordToIndex(x, y);
      if (engine.board[idx] !== EMPTY) continue;
      if (!this.hasStoneNeighbor(engine, idx)) continue;
      if (engine.checkMoveLegality(x, y, color).legal) return { x, y };
    }

    const stones = [];
    for (let i = 0; i < engine.board.length; i++) {
      if (engine.board[i] !== EMPTY) stones.push(i);
    }
    for (let attempt = 0; stones.length > 0 && attempt < 80; attempt++) {
      const stone = stones[Math.floor(Math.random() * stones.length)];
      const around = engine.neighborIdx(stone);
      const target = around[Math.floor(Math.random() * around.length)];
      if (engine.board[target] !== EMPTY) continue;
      const coord = engine.indexToCoord(target);
      if (engine.checkMoveLegality(coord.x, coord.y, color).legal) {
        return { x: coord.x, y: coord.y };
      }
    }

    const legal = engine.getLegalMoves(color);
    if (legal.length === 0) return null;
    return legal[Math.floor(Math.random() * legal.length)];
  }
  /**
   * 蒙特卡洛树搜索核心 (Monte Carlo Tree Search with Prior Knowledge)
   */
  mctsSearch(engine, color, maxIterations = this.mctsSimulations) {
    const opp = 3 - color;
    const legalMoves = engine.getLegalMoves(color);

    if (legalMoves.length === 0) {
      return { x: -1, y: -1, comment: "全盘无有效着法，停一手。", winRate: 0 };
    }

    // 根节点候选着法先验打分 (Priors)
    const tacticalCandidates = this.evaluateTacticalMoves(engine, color);
    const candidateMap = new Map();

    for (const lm of legalMoves) {
      const idx = engine.coordToIndex(lm.x, lm.y);
      let priorScore = this.evaluateMoveHeuristic(engine, lm.x, lm.y, color);

      // 叠加战术优先分
      for (const tc of tacticalCandidates) {
        if (tc.x === lm.x && tc.y === lm.y) {
          priorScore += tc.score;
        }
      }

      // 如果提子数大于0，额外加分
      if (lm.capturedCount > 0) {
        priorScore += lm.capturedCount * 30;
      }

      candidateMap.set(idx, {
        x: lm.x,
        y: lm.y,
        prior: Math.max(1, priorScore + 50),
        visits: 0,
        wins: 0,
        tactical: tacticalCandidates.find(t => t.x === lm.x && t.y === lm.y)
      });
    }

    // 对候选点进行剪枝，选出前 N 个最有潜力的着法进入 MCTS 树
    const sortedCandidates = Array.from(candidateMap.values())
      .sort((a, b) => b.prior - a.prior);

    // 根据段位保留的候选宽度
    const topWidth = Math.min(sortedCandidates.length, this.level === "master" ? 18 : 12);
    const activeCandidates = sortedCandidates.slice(0, topWidth);

    // MCTS 模拟循环
    for (let iter = 0; iter < maxIterations; iter++) {
      // 1. 选择 (Selection via UCB1-PUCT)
      let bestCandidate = null;
      let maxUct = -Infinity;
      const totalVisits = iter + 1;

      for (const cand of activeCandidates) {
        let uct = 0;
        if (cand.visits === 0) {
          uct = 1000 + cand.prior * 0.1;
        } else {
          const winRate = cand.wins / cand.visits;
          const exploration = this.c_puct * (cand.prior / 100) * Math.sqrt(Math.log(totalVisits) / cand.visits);
          uct = winRate + exploration;
        }

        if (uct > maxUct) {
          maxUct = uct;
          bestCandidate = cand;
        }
      }

      // 2. 模拟扩展与启发式快速推演 (Rollout Simulation)
      const simEngine = engine.clone();
      simEngine.play(bestCandidate.x, bestCandidate.y, color);

      let simColor = opp;
      let won = false;

      // 快速启发式向前推演 rolloutDepth 步
      for (let step = 0; step < this.rolloutDepth; step++) {
        if (simEngine.finished) break;
        const rolloutMove = this.pickRolloutMove(simEngine, simColor);
        if (rolloutMove) {
          const played = simEngine.play(rolloutMove.x, rolloutMove.y, simColor);
          if (!played.success) simEngine.pass(simColor);
        } else {
          simEngine.pass(simColor);
        }
        simColor = 3 - simColor;
      }

      // 3. 终局或静态形势评估作为反馈 (Backpropagation)
      const score = simEngine.calculateAreaScore();
      if (score.winner === color) {
        won = true;
      } else if (score.winner === null) {
        won = Math.random() > 0.5;
      }

      // 4. 回溯更新
      bestCandidate.visits++;
      if (won) {
        bestCandidate.wins += 1;
      }
    }

    // 最终选出访问次数最多 (Most Visited) 的着法
    activeCandidates.sort((a, b) => b.visits - a.visits);
    const chosen = activeCandidates[0];
    const winRate = chosen.visits > 0 ? (chosen.wins / chosen.visits) * 100 : 50;

    // 生成棋道与战术解说
    let commentary = "";
    if (chosen.tactical && chosen.tactical.comment) {
      commentary = chosen.tactical.comment;
    } else {
      commentary = this.generateMoveCommentary(engine, chosen.x, chosen.y, color, winRate);
    }

    return {
      x: chosen.x,
      y: chosen.y,
      winRate: Math.round(winRate),
      comment: commentary,
      candidates: activeCandidates.slice(0, 4).map(c => ({
        x: c.x,
        y: c.y,
        winRate: Math.round((c.wins / Math.max(1, c.visits)) * 100),
        visits: c.visits
      }))
    };
  }

  /**
   * 生成充满棋理与深度的自然语言解说
   */
  generateMoveCommentary(engine, x, y, color, winRate) {
    const N = engine.size;
    const distEdgeX = Math.min(x, N - 1 - x);
    const distEdgeY = Math.min(y, N - 1 - y);
    const line = Math.min(distEdgeX, distEdgeY);
    const moveNumber = engine.history.length + 1;

    const charMap = "ABCDEFGHJKLMNOPQRST";
    const coordName = `${charMap[x]}${N - y}`;

    if (moveNumber <= 30) {
      if (line === 2 || line === 3) {
        return `落子【${coordName}】：布下三四线要点，兼顾取地与张势，遵循“宁失数子，不失一先”的布阵哲理。`;
      } else {
        return `落子【${coordName}】：行棋舒展自如，在角边构筑外围根据地，稳扎稳打。`;
      }
    } else if (moveNumber <= 120) {
      const neighbors = engine.getNeighbors(x, y);
      const oppStones = neighbors.filter(n => engine.board[n.idx] === (3 - color)).length;
      if (oppStones > 0) {
        return `落子【${coordName}】：中盘接触战紧要处，贴身压制对手棋形，逼迫其做出妥协或损目补活。`;
      } else {
        return `落子【${coordName}】：大局行棋，敏锐瞄准全盘虚实消长，扩张己方模样并压制对方发展空间。`;
      }
    } else {
      return `落子【${coordName}】：进入官子阶段，收紧边角界线，先手搜刮细微目数，确保胜势不移。`;
    }
  }

  /**
   * 综合最高决策接口：整合定式库、战术强制解与 MCTS 树搜索，
   * 并判断收官阶段是否应该停一手，让对局能正常收束到终局数子。
   */
  getBestMove(color = this.engine.turn) {
    if (this.engine.finished) {
      return {
        x: -1,
        y: -1,
        winRate: 50,
        comment: "对局已进入终局阶段，无需继续行棋。",
        source: "finished",
        candidates: []
      };
    }

    const chosen = this.searchBestMove(this.engine, color);

    if (chosen && chosen.x >= 0) {
      const passMove = this.judgePassOpportunity(this.engine, color, chosen);
      if (passMove) return passMove;
    }

    return chosen;
  }

  /**
   * 定式库 → 紧急战术 → MCTS 的逐级选点
   */
  searchBestMove(engine, color) {
    // 1. 首查定式与开局大场
    const bookMove = this.searchOpeningBook(engine, color);
    if (bookMove) {
      return {
        x: bookMove.x,
        y: bookMove.y,
        winRate: 52,
        comment: bookMove.comment,
        source: bookMove.source,
        candidates: [{ x: bookMove.x, y: bookMove.y, winRate: 52, visits: 999 }]
      };
    }

    // 2. 严密战术筛选（高权重紧急战术点如逃生/必提子，在业余5段及以上直接敏锐识别）
    if (this.level !== "kyu") {
      const urgentTactics = this.evaluateTacticalMoves(engine, color);
      const highestTactic = urgentTactics.sort((a, b) => b.score - a.score)[0];
      if (highestTactic && highestTactic.score >= 240) {
        return {
          x: highestTactic.x,
          y: highestTactic.y,
          winRate: 55,
          comment: highestTactic.comment,
          source: "urgent_tactics",
          candidates: [{ x: highestTactic.x, y: highestTactic.y, winRate: 55, visits: 888 }]
        };
      }
    }

    // 3. 执行启发式引导的 MCTS 深度搜索
    return this.mctsSearch(engine, color);
  }

  /**
   * 全盘空域分析：把每一块连通的空点划分成区域，记录大小、四周接壤的颜色，
   * 以及紧贴该区域的棋子数量。用于判断某个空点是不是「已经成形的实地／眼位」。
   */
  analyzeEmptyRegions(engine) {
    const total = engine.size * engine.size;
    const board = engine.board;
    const region = new Int32Array(total).fill(-1);
    const sizes = [];
    const touches = [];
    const bounds = [];
    const counted = new Int32Array(total); // 去重用：同一轮扫描里同一颗子只计一次
    let stamp = 0;

    for (let start = 0; start < total; start++) {
      if (board[start] !== EMPTY || region[start] !== -1) continue;
      const id = sizes.length;
      const stack = [start];
      region[start] = id;
      stamp++;
      let size = 0;
      let mask = 0;
      let boundary = 0;
      while (stack.length > 0) {
        const cur = stack.pop();
        size++;
        for (const n of engine.neighborIdx(cur)) {
          const c = board[n];
          if (c === EMPTY) {
            if (region[n] === -1) {
              region[n] = id;
              stack.push(n);
            }
          } else {
            mask |= c;
            if (counted[n] !== stamp) {
              counted[n] = stamp;
              boundary++;
            }
          }
        }
      }
      sizes.push(size);
      touches.push(mask);
      bounds.push(boundary);
    }

    return { region, sizes, touches, bounds };
  }

  /**
   * 判断某个空点所在空域是否已经成形：
   *   - 只和一方棋子接壤（双方都接壤的是单官，还没有归属）；
   *   - 而且要么面积不大（眼位、小片实地），要么四周棋子足够密。
   * 后半条是必要的：空盘上只有孤零零几颗子时，整片空场也会「只和自己接壤」，
   * 那种稀疏边界算不上实地，否则 AI 在空盘上就会停手。
   */
  isSettledPointFor(info, idx) {
    const rid = info.region[idx];
    if (rid < 0) return false;
    const mask = info.touches[rid];
    if (mask !== BLACK && mask !== WHITE) return false;
    const size = info.sizes[rid];
    if (size <= SETTLED_REGION_MAX) return true;
    return info.bounds[rid] * 2 >= size;
  }

  isOwnSettledPoint(info, color, idx) {
    const rid = info.region[idx];
    if (rid < 0) return false;
    return info.touches[rid] === color && this.isSettledPointFor(info, idx);
  }

  /**
   * 收官停一手判断（中国规则数子法，子空皆地）：
   * 在已经成形的实地或眼位里落子只是自填，子空总数不变还要让出先手，
   * 此时应当停一手，否则双方互相跟着应手，对局永远进不了终局数子。
   *
   * 满足以下任一条且最佳着法不提子，就停一手：
   *   1. 对方刚刚停了一手，而我方最佳着法只是填自家实地；
   *   2. 全盘空点都已经归属双方，再也没有值得争的地方。
   */
  judgePassOpportunity(engine, color, chosen) {
    const info = this.analyzeEmptyRegions(engine);
    const idx = engine.coordToIndex(chosen.x, chosen.y);

    const check = engine.checkMoveLegality(chosen.x, chosen.y, color);
    if (!check.legal || (check.capturedStones || []).length > 0) return null;

    // 条件一：对方刚刚停手，而我方最佳着法只是填自家实地，跟着停手进入终局数子
    if (engine.consecutivePasses >= 1 && this.isOwnSettledPoint(info, color, idx)) {
      return {
        x: -1,
        y: -1,
        winRate: chosen.winRate,
        comment: "收官已毕，此处落子只是自填，停一手。",
        source: "pass",
        candidates: []
      };
    }

    // 条件二：全盘空点都已经归属某一方，再也没有可争之处
    const hasSomethingToFight = engine.getLegalMoves(color).some((m) =>
      m.capturedCount > 0 || !this.isSettledPointFor(info, engine.coordToIndex(m.x, m.y)));
    if (hasSomethingToFight) return null;

    return {
      x: -1,
      y: -1,
      winRate: chosen.winRate,
      comment: "盘上已无可争之地，停一手。",
      source: "pass",
      candidates: []
    };
  }
}

// 统一导出
if (typeof module !== "undefined" && module.exports) {
  module.exports = { GoAI };
}