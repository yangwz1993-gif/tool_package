// lib/budget.mjs — DS v4 预算计算与监控
// 价格（元/百万token，DS 官网 2026-08）：deepseek-v4-flash / -vision-exp 同价
//   输入(缓存命中): 0.05 (空闲) / 0.10 (高峰)
//   输入(未命中):   1.5  (空闲) / 3.0  (高峰)
//   输出:           4.5  (空闲) / 9.0  (高峰)
//   图片: 每张最多 384 tokens（自动缩放到 ~800×800）
// 高峰时段: 北京周一~五 9-12, 14-18

export const PRICE = {
  input_cached:   { offpeak: 0.05, peak: 0.10 },
  input_uncached: { offpeak: 1.5,  peak: 3.0 },
  output:         { offpeak: 4.5,  peak: 9.0 },
  image_tokens_per_img: 384, // 上限
};

export function isPeak() {
  const now = new Date();
  const d = new Date(now.getTime() + 8 * 3600 * 1000); // 转北京
  const day = d.getUTCDay(); // 0=周日
  const hour = d.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  const peakHour = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  return weekday && peakHour;
}

/** 估算一次请求成本（元） */
export function estimateCost({ inputTokens, outputTokens, cachedTokens = 0, images = 0, imageDetail = "auto" }) {
  const peak = isPeak();
  const imgTokens = images * PRICE.image_tokens_per_img;
  const uncached = Math.max(0, inputTokens - cachedTokens) + imgTokens;
  const cost =
    (cachedTokens * PRICE.input_cached[peak ? "peak" : "offpeak"] +
     uncached * PRICE.input_uncached[peak ? "peak" : "offpeak"] +
     outputTokens * PRICE.output[peak ? "peak" : "offpeak"]) / 1e6;
  return cost;
}

/** 预算跟踪器 */
export class BudgetTracker {
  constructor(budgetYuan, targetCount) {
    this.budget = budgetYuan;
    this.targetCount = targetCount;
    this.spent = 0;
    this.hardLimit = budgetYuan * 0.9; // 90% 停止线
    this.log = [];
  }
  spend({ inputTokens = 0, outputTokens = 0, cachedTokens = 0, images = 0, note = "" }) {
    const c = estimateCost({ inputTokens, outputTokens, cachedTokens, images });
    this.spent += c;
    this.log.push({ cost: c, inputTokens, outputTokens, images, note, t: Date.now() });
    return c;
  }
  get ratio() { return this.spent / this.budget; }
  get shouldStop() { return this.spent >= this.hardLimit; }
  /** 估算预算是否合理：基于上次 10 条任务的实际开销 */
  estimateReasonableness(prevSpentYuan, prevCount) {
    const perItem = prevSpentYuan / prevCount;
    const needed = perItem * this.targetCount;
    return {
      perItem, needed,
      reasonable: needed <= this.budget,
      suggestion: needed > this.budget
        ? `上次 ${prevCount} 条花 ${prevSpentYuan.toFixed(3)} 元，这次 ${this.targetCount} 条约需 ${needed.toFixed(3)} 元，建议预算 ≥ ${needed.toFixed(3)} 元`
        : `上次 ${prevCount} 条花 ${prevSpentYuan.toFixed(3)} 元（单条约 ${perItem.toFixed(3)} 元），预算 ${this.budget} 元够用`,
    };
  }
}

/** 打印预算状态 */
export function budgetStatus(b) {
  return `预算: 已用 ¥${b.spent.toFixed(4)} / ¥${b.budget} (${(b.ratio * 100).toFixed(1)}%) 停止线: 90%`;
}
