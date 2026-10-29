/**
 * DeepSeek 官方价目（2026-10-29 抓取自 api-docs.deepseek.com/zh-cn/quick_start/pricing/）。
 *
 * 官方口径：
 *   - 空闲时段价格 = 高峰时段价格的一半；
 *   - 北京时间 周一至周五（不含法定节假日）09:00-12:00、14:00-18:00 为高峰，其余为空闲。
 *
 * 本项目约定：**对外报成本一律换算成谷价（空闲时段）**，避免「哪次跑在峰价」导致数字不可比；
 * 同时保留峰价作为上界。换算只依赖 token 用量，不需要知道当时几点。
 *
 * 注意：节假日无法从本地安全判定（需要节假日表），这里只处理周末。若运行日恰逢中国法定节假日，
 * 用北京时间工作日规则会把谷价误判成峰价——所以**记账不按时间猜**，而是在请求回执里同时记两种价格。
 */

export const PRICING = Object.freeze({
  "deepseek-flash": {
    peak: { inputMiss: 2, cachedInput: 0.04, output: 8 },
    offpeak: { inputMiss: 1, cachedInput: 0.02, output: 4 },
  },
  "deepseek-v4-pro": {
    peak: { inputMiss: 9, cachedInput: 0.3, output: 27 },
    offpeak: { inputMiss: 4.5, cachedInput: 0.15, output: 13.5 },
  },
  // 旧别名：服务端当前把它路由到 deepseek-flash，按 flash 计费（2026-10-29 实测回显 model=deepseek-flash）。
  "deepseek-chat": {
    peak: { inputMiss: 2, cachedInput: 0.04, output: 8 },
    offpeak: { inputMiss: 1, cachedInput: 0.02, output: 4 },
    aliasOf: "deepseek-flash",
  },
});

export const PRICE_SOURCE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
export const PRICE_CAPTURED_AT = "2026-10-29";

/** Beijing wall clock (UTC+8) regardless of the machine's zone. */
export function beijingNow(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600 * 1000);
}

/** Peak = Mon-Fri 09:00-12:00 / 14:00-18:00 Beijing. Holidays are NOT modelled here. */
export function windowAt(now = new Date()) {
  const bj = beijingNow(now);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return "offpeak";
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const inMorning = minutes >= 9 * 60 && minutes < 12 * 60;
  const inAfternoon = minutes >= 14 * 60 && minutes < 18 * 60;
  return inMorning || inAfternoon ? "peak" : "offpeak";
}

function tableFor(model) {
  const name = String(model || "deepseek-flash");
  return PRICING[name] || PRICING["deepseek-flash"];
}

/**
 * Cost in CNY for one provider usage object.
 * `usage.prompt_tokens` includes cached tokens; the cached share is billed separately.
 */
export function priceUsage(usage, { model = "deepseek-flash", window = "offpeak" } = {}) {
  const table = tableFor(model)[window] || tableFor(model).offpeak;
  const prompt = Number(usage?.prompt_tokens || 0);
  const cached = Math.min(prompt, Math.max(0, Number(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0)));
  const completion = Number(usage?.completion_tokens || 0);
  return ((prompt - cached) * table.inputMiss + cached * table.cachedInput + completion * table.output) / 1e6;
}

/** Both windows at once — the ledger stores these instead of guessing when it ran. */
export function priceBoth(usage, model = "deepseek-flash") {
  return { peak: priceUsage(usage, { model, window: "peak" }), offpeak: priceUsage(usage, { model, window: "offpeak" }) };
}

/** Which model a request was actually served by, from the provider's echoed `model`. */
export function servedModel(echoed, requested) {
  return String(echoed || requested || "deepseek-flash");
}
