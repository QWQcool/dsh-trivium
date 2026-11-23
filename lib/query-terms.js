/** Bounded lexical equivalences, not translation or an answerability decision. */
const segmenter = new Intl.Segmenter('zh', {granularity:'word'});
const stop = new Set(('的 了 是 在 有 和 与 请 什么 哪些 怎么 如何 一下 这个 我们 多少 几 每个 允许 配置 配置为 使用 the a an is are to of for and what how which does do use uses configured has have each per many long s').split(' '));
// Each group gets one vote. Adding aliases must not inflate the denominator.
const concepts = Object.freeze([
  ['backup','backups','备份'], ['retention','retained','retain','retention period','保留期','保留'],
  ['retry count','retries','retry','重试次数','重试'], ['port','ports','端口'],
  ['timeout','time out','超时时间','超时'], ['rate limit','rate limits','rate limiting','限流'],
  ['rps','per second','每秒'], ['request','requests','请求'],
  ['concurrency','concurrent','并发','最大并发'], ['owner','负责人'],
  ['deployment','deploy','部署'], ['encryption','encrypted','加密'],
]);
const plans = new Map();
const escaped = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function containsLexical(hay, term) {
  return /\p{Script=Han}/u.test(term) ? hay.includes(term)
    : new RegExp(`(?:^|[^a-z0-9_])${escaped(term)}(?:$|[^a-z0-9_])`,'i').test(hay);
}
export function queryLexicalPlan(input) {
  const text=String(input||'').trim().toLowerCase().replace(/[’']/g,"'").replace(/\b([a-z0-9_]+)'s\b/g,'$1');
  if(plans.has(text))return plans.get(text);
  const atomic=text.match(/[a-z0-9_]+(?:[-./:][a-z0-9_]+)+/gi)||[];
  const conceptText=text.replace(/[a-z0-9_]+(?:[-./:][a-z0-9_]+)+/gi,' ');
  const groups=[];let remainder=conceptText;
  for(const aliases of concepts) {
    if(aliases.some(term=>containsLexical(conceptText,term))) {
      groups.push(aliases);
      for(const term of [...aliases].sort((a,b)=>b.length-a.length))
        remainder=remainder.replace(new RegExp(/\p{Script=Han}/u.test(term)?escaped(term):`\\b${escaped(term)}\\b`,'gi'),' ');
    }
  }
  const chunks=remainder.match(/[\p{L}\p{N}_]+(?:[-./:][\p{L}\p{N}_]+)*/gu)||[];
  const terms=[...new Set([...atomic,...chunks.flatMap(chunk=>/\p{Script=Han}/u.test(chunk)?[...segmenter.segment(chunk)].filter(p=>p.isWordLike).map(p=>p.segment):[chunk])]
    .filter(term=>term.length>=2&&!stop.has(term)))].slice(0,24-groups.length);
  groups.push(...terms.map(term=>[term]));
  const plan=Object.freeze({text,groups:Object.freeze(groups.map(g=>Object.freeze([...g]))),terms:Object.freeze([...new Set(groups.flat())]),
    identifiers:Object.freeze([...new Set(atomic.filter(term=>/[a-z]/i.test(term)))])});
  if(plans.size>=128)plans.delete(plans.keys().next().value);
  plans.set(text,plan);return plan;
}
export function lexicalCoverage(haystack,input) {
  const hay=String(haystack||'').toLowerCase(),plan=queryLexicalPlan(input);
  // A compound code identifier is atomic even inside a natural-language query.
  if(!identifiersMatch(hay,input))return 0;
  if(plan.text.length>=2&&hay.includes(plan.text))return 2;
  if(!plan.groups.length)return 0;
  const covered=plan.groups.filter(group=>group.some(term=>containsLexical(hay,term))).length/plan.groups.length;
  // A complete requested code is sufficient evidence to retrieve its fact,
  // including a long question that compares several different identifiers.
  return plan.identifiers.length?Math.max(0.5,covered):covered>=0.5?covered:0;
}
export function identifiersMatch(haystack,input) {
  const plan=queryLexicalPlan(input);
  if(!plan.identifiers.length)return true;
  const tokens=String(haystack||'').toLowerCase().match(/[a-z0-9_]+(?:[-./:][a-z0-9_]+)*/g)||[];
  // A comparison can name several independent facts. Require one complete
  // requested code identity, never all of them in every individual fact.
  return plan.identifiers.some(term=>tokens.includes(term));
}

// Scoped fallback pairs. Require independent signals in the opposite language.
// Keep these separate from the default recall vocabulary and scoring.
const bilingualBodyPhrases = [
  [['搜索日志','查询日志'], ['search logs','query logs']],
  [['保留','留存'], ['keep','keeps','retain','retains','retained','retention']],
  [['死信'], ['dead letter','dead letters']],
  [['文件格式','格式'], ['file format','csv','tsv','json','jsonl','parquet','xml']],
  [['写入','导出','输出'], ['write','writes','export','exports','output','outputs']],
  [['探测','探查'], ['probe','probes','ping','pings']],
  [['每隔','间隔'], ['every','interval']],
  [['每秒','秒吞吐'], ['per second','rps','qps']],
  [['抓取','爬取'], ['fetch','fetches','crawl','crawls']],
  [['页','页面'], ['page','pages']],
].map(([han, latin]) => [new RegExp(han.map(escaped).join('|'), 'u'),
  new RegExp(`(?:^|[^a-z0-9_])(?:${latin.map(escaped).join('|')})(?=$|[^a-z0-9_])`, 'i')]);

export function makeBilingualBodyScorer(question, labels) {
  const names = labels.filter(value => typeof value === 'string').map(value => value.normalize('NFKC').trim().toLowerCase())
    .filter(value => value.length >= 2 && value.length <= 160).sort((a,b) => b.length-a.length);
  const patterns = names.map(name => new RegExp(/\p{Script=Han}/u.test(name) ? escaped(name)
    : `(^|[^a-z0-9_])${escaped(name)}(?=$|[^a-z0-9_])`, 'giu'));
  const withoutLabels = text => patterns.reduce((value, pattern) => value.replace(pattern, ' '), text.normalize('NFKC').toLowerCase());
  const query = withoutLabels(question);
  const opposite = bilingualBodyPhrases.flatMap(([han, latin]) => {
    const [inHan, inLatin] = [han.test(query), latin.test(query)];
    return inHan === inLatin ? [] : [inHan ? latin : han];
  });
  if (opposite.length < 2) return null;
  const numbers = text => text.match(/(?<![a-z0-9_.])[-+]?\d+(?:\.\d+)?(?![a-z0-9_]|\.\d)/g) || [];
  const expected = numbers(query);
  return text => {
    if (typeof text !== 'string') return 0;
    const body = withoutLabels(text);
    if (!opposite.every(phrase => phrase.test(body)) || !identifiersMatch(body, query)) return 0;
    if (expected.length && !expected.every(value => numbers(body).includes(value))) return 0;
    return 0.4;
  };
}
