/**
 * 围棋高阶 AI Web Worker
 * 用于将复杂的 MCTS 树搜索与死活战术运算完全放在后台线程中执行，
 * 确保网页前端以 60 FPS 极度流畅运行，杜绝界面卡顿。
 */

// 尝试加载引擎与 AI 模块
try {
  importScripts("./go_engine.js", "./go_ai.js");
} catch (e) {
  console.warn("importScripts 失败，若是内联模式将依赖全局环境", e);
}

self.onmessage = function (e) {
  const data = e.data;
  if (!data) return;

  if (data.action === "think") {
    const size = data.size || 19;
    const komi = data.komi || 7.5;
    const level = data.level || "dan";
    const turn = data.turn || 2; // 默认白棋

    // 重构 GoEngine
    const engine = new GoEngine(size, komi);
    if (data.board) {
      engine.board = new Uint8Array(data.board);
    }
    engine.turn = turn;
    if (data.captures) {
      engine.captures = { ...data.captures };
    }
    if (data.koPoint !== undefined) {
      engine.koPoint = data.koPoint;
    }
    if (data.history) {
      engine.history = data.history.map(h => ({
        board: new Uint8Array(h.board),
        move: { ...h.move },
        captures: { ...h.captures },
        koPoint: h.koPoint
      }));
    }

    // 运行 AI 思考
    const ai = new GoAI(engine, level);
    const bestMove = ai.getBestMove(turn);
    const scoreResult = engine.calculateAreaScore();

    self.postMessage({
      type: "move_result",
      move: bestMove,
      scoreResult: {
        winner: scoreResult.winner,
        margin: scoreResult.margin,
        blackTotal: scoreResult.blackTotal,
        whiteTotal: scoreResult.whiteTotal,
        territory: Array.from(scoreResult.territory)
      }
    });
  } else if (data.action === "evaluate") {
    const size = data.size || 19;
    const komi = data.komi || 7.5;
    const engine = new GoEngine(size, komi);
    if (data.board) {
      engine.board = new Uint8Array(data.board);
    }
    const scoreResult = engine.calculateAreaScore();
    self.postMessage({
      type: "eval_result",
      scoreResult: {
        winner: scoreResult.winner,
        margin: scoreResult.margin,
        blackTotal: scoreResult.blackTotal,
        whiteTotal: scoreResult.whiteTotal,
        territory: Array.from(scoreResult.territory)
      }
    });
  }
};
