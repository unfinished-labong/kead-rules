// 공단 규정 MCP 서버
// 인덱스를 깃허브에서 받아 메모리에 주소록(역색인)을 만들고, 조문을 찾아 돌려준다.
// 외부 라이브러리 없이 Node 기본 기능만 쓴다

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const INDEX_URL = process.env.INDEX_URL;          // data/index.json 의 raw 주소
const REFRESH_MS = Number(process.env.REFRESH_MIN ?? 60) * 60 * 1000;
const MAX_TEXT = 1800;                            // 조문 하나를 돌려줄 때 최대 글자 수

// 접근 열쇠. "열쇠:이름,열쇠:이름" 형태로 넣는다. 비워두면 누구나 쓸 수 있다.
// 반드시 Fly.io Secrets 로 넣을 것. fly.toml 에 적으면 깃허브에 그대로 공개된다.
const KEYS = new Map(
  (process.env.ACCESS_KEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':');
      return i < 0 ? [pair, '이름없음'] : [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
    })
);
const MAX_HITS = 8;

if (!INDEX_URL) {
  console.error('환경변수 INDEX_URL 이 필요합니다. (data/index.json 의 raw 주소)');
  process.exit(1);
}

// ── 검색용 정규화 ──────────────────────────────────────────
// build-index.js 의 normText 와 같은 규칙이어야 한다.
function normText(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[·ㆍ‧∙・]/g, '')
    .replace(/[^가-힣A-Za-z0-9]/g, '')
    .toLowerCase();
}

// 글자 두 개씩 자른다. 한국어는 조사가 붙어 단어 경계가 흐려서 이 방식이 잘 맞는다.
function grams(s, k = 2) {
  const out = [];
  for (let i = 0; i + k <= s.length; i++) out.push(s.slice(i, i + k));
  return out;
}

// ── 상태 ───────────────────────────────────────────────────
let STATE = null;
let loading = null;

// force=false 이면 바뀐 게 없을 때 그냥 넘어간다.
// 깃허브는 하루 한 번만 바뀌므로 매번 다시 만드는 것은 낭비다.
async function loadIndex(force = false) {
  const t0 = Date.now();
  const headers = { 'User-Agent': 'kead-rules-mcp/1.0' };
  if (!force && STATE?.etag) headers['If-None-Match'] = STATE.etag;

  const res = await fetch(INDEX_URL, { headers });
  if (res.status === 304) {                      // 서버가 '안 바뀜'이라고 답한 경우
    console.log('인덱스 변화 없음 (304)');
    return;
  }
  if (!res.ok) throw new Error(`인덱스 내려받기 실패: HTTP ${res.status}`);
  const etag = res.headers.get('etag');
  const idx = await res.json();

  // ETag를 안 주는 경우를 대비해 만들어진 시각으로도 한 번 더 확인한다
  if (!force && STATE && idx.builtAt === STATE.idx.builtAt) {
    STATE.etag = etag ?? STATE.etag;
    console.log('인덱스 변화 없음 (builtAt 동일)');
    return;
  }

  const docs = new Map(idx.docs.map((d) => [d.docId, d]));
  const articles = idx.articles;

  // 주소록: 글자조각 → 그 조각이 들어 있는 조문 번호 목록
  const postings = new Map();
  const lens = new Array(articles.length);
  for (let i = 0; i < articles.length; i++) {
    const norm = (articles[i].norm ?? normText(articles[i].text)).slice(0, 3000);
    lens[i] = Math.max(norm.length, 1);
    articles[i].norm = norm;
    const seen = new Set(grams(norm));
    for (const g of seen) {
      let p = postings.get(g);
      if (!p) postings.set(g, (p = []));
      p.push(i);
    }
  }

  STATE = {
    idx,
    etag,
    docs,
    articles,
    postings,
    lens,
    N: articles.length,
    loadedAt: new Date().toISOString(),
  };
  console.log(
    `인덱스 적재: 문서 ${docs.size} / 조문 ${articles.length} / 색인어 ${postings.size} / ${Date.now() - t0}ms`
  );
}

async function ensureIndex() {
  if (STATE) return STATE;
  if (!loading) loading = loadIndex(true).finally(() => (loading = null));
  await loading;
  return STATE;
}

// 주기적으로 확인만 한다. 바뀌지 않았으면 아무 일도 하지 않는다.
setInterval(() => {
  loadIndex().catch((e) => console.error('인덱스 갱신 실패:', e.message));
}, REFRESH_MS).unref();

// ── 검색 ───────────────────────────────────────────────────
const SECTION_WEIGHT = { 본칙: 1, 별표: 0.75, 부칙: 0.45 };
const MIN_COVERAGE = 0.34;   // 질의 조각이 이만큼은 겹쳐야 후보로 본다
const MIN_SCORE = 8;         // 실측: 정상 질문 26~68점, 무관한 질문 0~4점

function search(query, { scope, section, limit = MAX_HITS } = {}) {
  const S = STATE;
  const qn = normText(query);
  if (qn.length < 2) return [];

  const qg = [...new Set(grams(qn))];
  const qset = new Set(qg);
  const scores = new Map();
  const hits = new Map();

  for (const g of qg) {
    const post = S.postings.get(g);
    if (!post) continue;
    if (post.length > S.N * 0.4) continue;              // 너무 흔한 조각은 변별력이 없다
    const idf = Math.log(1 + S.N / post.length);
    for (const i of post) {
      scores.set(i, (scores.get(i) ?? 0) + idf);
      hits.set(i, (hits.get(i) ?? 0) + 1);
    }
  }
  if (!scores.size) return [];

  // 문서명 가중치: 겹친 조각 수를 곱해 더 긴 이름이 이기게 하고, 빠진 부분은 제곱으로 벌한다.
  // '인사규정'과 '인사규정 시행규칙'이 함께 걸릴 때 뒤엣것이 이겨야 한다.
  const nameBoost = new Map();
  for (const d of S.docs.values()) {
    const dg = [...new Set(grams(normText(d.name)))];
    if (!dg.length) continue;
    let n = 0;
    for (const g of dg) if (qset.has(g)) n++;
    const ratio = n / dg.length;
    if (ratio >= 0.6) nameBoost.set(d.docId, 1 + 0.6 * n * ratio * ratio);
  }

  const m = query.match(/제\s*(\d+)\s*조(?:의\s*(\d+))?/);
  const wantId = m ? `제${m[1]}조${m[2] ? `의${m[2]}` : ''}` : null;

  // 문서와 조문을 콕 집어 물은 경우는 점수 경쟁에 맡기지 않고 그 조문을 1위로 고정한다
  let pinned = null;
  if (wantId && nameBoost.size) {
    const best = [...nameBoost.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const j = S.articles.findIndex((x) => x.docId === best && x.articleId === wantId && x.section === '본칙');
    if (j >= 0) pinned = j;
  }

  const out = [];
  for (const [i, raw] of scores) {
    const a = S.articles[i];
    if (scope === '법제처' && !a.docId.startsWith('법령:')) continue;
    if (scope === '내부규정' && !a.docId.startsWith('내규:')) continue;
    if (section && a.section !== section) continue;

    const cov = hits.get(i) / qg.length;                // 질의 조각 중 몇 퍼센트가 이 조문에 있나
    const nb = nameBoost.get(a.docId) ?? 1;
    if (cov < MIN_COVERAGE && nb <= 1) continue;

    let s = raw / Math.sqrt(S.lens[i] / 200 + 1);       // 긴 조문이 무조건 유리해지지 않게
    s *= 0.4 + cov;
    s *= SECTION_WEIGHT[a.section] ?? 1;
    if (a.norm.includes(qn)) s *= 2.2;                  // 질의가 통째로 들어 있으면 강하게
    s *= nb;
    if (wantId && a.articleId === wantId) s *= 3;
    out.push({ i, s });
  }

  out.sort((x, y) => y.s - x.s);
  if (pinned != null) {
    const k = out.findIndex((o) => o.i === pinned);
    if (k >= 0) out.unshift(out.splice(k, 1)[0]);
    else out.unshift({ i: pinned, s: 999 });
  }
  // 근거가 약한 결과는 아예 내보내지 않는다. 없는 내용을 지어내는 것보다 못 찾았다고 하는 게 낫다.
  const passed = out.filter((o) => o.s >= MIN_SCORE);
  return passed.slice(0, limit).map(({ i, s }) => ({ ...S.articles[i], _score: s }));
}

// ── 출력 형식 ──────────────────────────────────────────────
function clip(t) {
  const s = String(t ?? '');
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n…(이하 생략, 원문 확인 필요)' : s;
}

function renderArticle(a, withText = true) {
  const d = STATE.docs.get(a.docId);
  const head = [
    `■ ${d?.name ?? '(문서명 없음)'} ${a.articleId}`,
    `  출처: ${d?.source ?? '-'}${d?.kind ? ` · ${d.kind}` : ''}`,
    `  구분: ${a.section}${a.section !== '본칙' ? ' (본칙 아님)' : ''}`,
    `  시행일: ${d?.effectiveDate ?? '표기 없음'}${d?.lawNo ? ` · 제${d.lawNo}호` : ''}`,
    `  상태: ${d?.status ?? '-'}`,
  ];
  if (a.needsOriginal) head.push('  ※ 별표·도표가 포함된 조문입니다. 정확한 내용은 원문을 확인하세요.');
  if (d?.originalUrl) head.push(`  원문: ${d.originalUrl}`);
  if (withText) head.push('', clip(a.text));
  return head.join('\n');
}

const NOT_FOUND = (msg, hint) =>
  `[NOT_FOUND] ${msg}\n` +
  `LLM 주의: 아래 자료에 근거가 없습니다. 추측하거나 조문을 지어내지 마십시오.\n` +
  `사용자에게 "수록된 규정에서 근거를 찾지 못했다"고 답하십시오.` +
  (hint ? `\n참고: ${hint}` : '');

function footer() {
  return `\n---\n자료 기준일: ${STATE.idx.dataAsOf} · 수록 문서 ${STATE.docs.size}건 / 조문 ${STATE.N}건`;
}

// ── 도구 ───────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_provisions',
    description:
      '한국장애인고용공단의 내부규정·규칙·정관과 장애인 고용 관련 법령·고시에서 조문을 검색한다.\n' +
      '【반드시 먼저 호출해야 하는 경우】 공단 업무와 관련된 질문이면 웹 검색이나 사전 지식에 의존하지 말고 ' +
      '이 도구를 먼저 호출한다. 특히 다음 낱말이 하나라도 있으면 해당한다: ' +
      '규정, 규칙, 지침, 조문, 별표, 서식, 절차, 기준, 요건, 자격, 한도, 수당, 급여, 보수, 여비, 강사료, ' +
      '지원금, 장려금, 부담금, 융자, 신청, 접수, 심사, 지급, 환수, 훈련, 취업지원, 근로지원인, 보조공학기기, ' +
      '표준사업장, 인사, 복무, 징계, 휴가, 감사, 계약, 위탁, 제출서류.\n' +
      '【답변 규칙】 이 도구가 돌려준 조문에 실제로 적힌 내용만 근거로 삼는다. ' +
      '결과가 [NOT_FOUND]이면 추측하지 말고 "수록된 규정에서 근거를 찾지 못했다"고 답한다. ' +
      '한 번에 못 찾으면 다른 낱말로 2~3회 더 시도한 뒤에 판단한다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '찾고자 하는 내용. 예: 부담기초액, 근로지원인 신청 절차, 인사규정 제5조' },
        scope: { type: 'string', enum: ['전체', '내부규정', '법제처'], description: '검색 범위. 기본값 전체' },
        section: { type: 'string', enum: ['본칙', '부칙', '별표'], description: '특정 구분만 볼 때. 기본은 전체이며 본칙이 우선 노출됨' },
        limit: { type: 'number', description: '결과 개수. 기본 8, 최대 15' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_provision',
    description:
      '문서명과 조문번호를 알 때 그 조문의 원문을 그대로 가져온다. 예: 인사규정 시행규칙 제5조, 교육훈련규칙 [별표 4].\n' +
      '사용자가 특정 조문이나 별표를 지목했다면 검색보다 이 도구를 먼저 쓴다. 원문을 고치거나 요약하지 말고 그대로 인용한다.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: '규정 이름. 일부만 적어도 된다. 예: 인사규정 시행규칙' },
        article: { type: 'string', description: '조문번호. 예: 제5조, 제12조의2, 전문' },
      },
      required: ['document', 'article'],
    },
  },
  {
    name: 'list_documents',
    description:
      '어떤 규정이 어느 시점 기준으로 수록되어 있는지 확인한다.\n' +
      'search_provisions 가 [NOT_FOUND]를 돌려줬을 때, 자료 자체가 없는 것인지 검색어가 안 맞은 것인지 ' +
      '가리기 위해 반드시 이 도구로 한 번 더 확인한 뒤에 "없다"고 답한다.',
    inputSchema: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '문서명에 포함된 낱말. 비우면 전체' } },
    },
  },
];

async function callTool(name, args = {}) {
  await ensureIndex();

  if (name === 'search_provisions') {
    const limit = Math.min(Math.max(Number(args.limit) || MAX_HITS, 1), 15);
    const scope = args.scope === '전체' ? undefined : args.scope;
    const hits = search(String(args.query ?? ''), { scope, section: args.section, limit });
    if (!hits.length) {
      return NOT_FOUND(
        `"${args.query}" 로 검색된 조문이 없습니다.`,
        'list_documents 로 수록 범위를 확인하거나, 다른 낱말로 다시 검색해 보십시오.'
      );
    }
    return (
      `검색어: ${args.query} · ${hits.length}건\n` +
      `아래 조문에 실제로 적힌 내용만 근거로 답하고, 인용할 때는 문서명과 조문번호를 함께 밝히십시오.\n\n` +
      hits.map((a) => renderArticle(a)).join('\n\n') +
      footer()
    );
  }

  if (name === 'get_provision') {
    const dq = normText(args.document);
    const cands = [...STATE.docs.values()].filter((d) => normText(d.name).includes(dq));
    if (!cands.length) return NOT_FOUND(`"${args.document}" 이라는 규정을 찾지 못했습니다.`, 'list_documents 로 이름을 확인하십시오.');

    const want = String(args.article ?? '').replace(/\s/g, '');
    for (const d of cands) {
      const a = STATE.articles.find((x) => x.docId === d.docId && x.articleId.replace(/\s/g, '') === want);
      if (a) return renderArticle(a) + footer();
    }
    const ids = STATE.articles
      .filter((x) => x.docId === cands[0].docId && x.section === '본칙')
      .map((x) => x.articleId);
    return NOT_FOUND(
      `"${cands[0].name}" 에 ${args.article} 이(가) 없습니다.`,
      `수록된 조문: ${ids.slice(0, 40).join(', ')}${ids.length > 40 ? ' …' : ''}`
    );
  }

  if (name === 'list_documents') {
    const kw = normText(args.keyword ?? '');
    const list = [...STATE.docs.values()].filter((d) => !kw || normText(d.name).includes(kw));
    if (!list.length) return NOT_FOUND(`"${args.keyword}" 이 들어간 규정이 없습니다.`);
    const counts = new Map();
    for (const a of STATE.articles) counts.set(a.docId, (counts.get(a.docId) ?? 0) + 1);
    return (
      `수록 문서 ${list.length}건\n\n` +
      list
        .map((d) => `· ${d.name} (${d.source}${d.kind ? ` · ${d.kind}` : ''}) 시행 ${d.effectiveDate ?? '표기 없음'} · 조문 ${counts.get(d.docId) ?? 0}`)
        .join('\n') +
      footer()
    );
  }

  return `[NOT_FOUND] 알 수 없는 도구: ${name}`;
}

// ── MCP (JSON-RPC over HTTP) ───────────────────────────────
const PROTOCOL = '2025-06-18';

async function handleRpc(msg) {
  const { id, method, params } = msg ?? {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });

  if (method === 'initialize') {
    return ok({
      protocolVersion: params?.protocolVersion ?? PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'kead-rules', version: '1.0.0' },
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const text = await callTool(params?.name, params?.arguments ?? {});
      const isError = text.startsWith('[NOT_FOUND]');
      return ok({ content: [{ type: 'text', text }], isError });
    } catch (e) {
      return ok({ content: [{ type: 'text', text: `[ERROR] ${e.message}` }], isError: true });
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `지원하지 않는 method: ${method}` } };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
};

// ── 요청 횟수 제한 ────────────────────────────────────────
// 열쇠는 자료 유출을 막지만 요청이 쏟아지는 것은 못 막는다.
// 같은 곳에서 짧은 시간에 너무 많이 두드리면 잠시 막는다.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_OK = Number(process.env.RATE_MAX ?? 60);        // 정상 이용자: 분당 60회
const RATE_MAX_BAD = 10;                                       // 열쇠 틀린 곳: 분당 10회
const buckets = new Map();

function rateLimited(ip, limit) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > RATE_WINDOW_MS) {
    b = { start: now, n: 0 };
    buckets.set(ip, b);
  }
  b.n++;
  return b.n > limit;
}

// 오래된 기록은 버린다
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.start > RATE_WINDOW_MS * 5) buckets.delete(ip);
}, RATE_WINDOW_MS).unref();

function clientIp(req) {
  return (req.headers['fly-client-ip'] ?? req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?')
    .toString()
    .split(',')[0]
    .trim();
}

// 열쇠 확인. 주소 뒤의 ?k= 또는 Authorization 헤더 둘 다 받는다.
function checkKey(req, url) {
  if (!KEYS.size) return { ok: true, who: '공개' };          // 열쇠를 안 걸었으면 통과
  const fromQuery = url.searchParams.get('k');
  const auth = req.headers.authorization ?? '';
  const fromHeader = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const key = fromQuery || fromHeader;
  if (key && KEYS.has(key)) return { ok: true, who: KEYS.get(key) };
  return { ok: false, who: null };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    const body = STATE
      ? { ok: true, docs: STATE.docs.size, articles: STATE.N, dataAsOf: STATE.idx.dataAsOf, loadedAt: STATE.loadedAt }
      : { ok: false, note: '인덱스 적재 전' };
    if (STATE) body.keyRequired = KEYS.size > 0;
    return res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }

  if (req.method !== 'POST' || url.pathname !== '/mcp') {
    return res.writeHead(405, CORS).end();
  }

  const ip = clientIp(req);
  const pass = checkKey(req, url);

  if (rateLimited(ip, pass.ok ? RATE_MAX_OK : RATE_MAX_BAD)) {
    console.warn(`횟수 초과 차단 · ${ip}`);
    return res
      .writeHead(429, { ...CORS, 'Content-Type': 'application/json', 'Retry-After': '60' })
      .end(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32002, message: '요청이 너무 잦습니다. 1분 뒤에 다시 시도하세요.' },
      }));
  }

  if (!pass.ok) {
    console.warn(`접근 거부 · ${ip}`);
    return res
      .writeHead(401, { ...CORS, 'Content-Type': 'application/json' })
      .end(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32001, message: '접근 열쇠가 없거나 올바르지 않습니다. 커넥터 주소를 확인하세요.' },
      }));
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return res
      .writeHead(400, { ...CORS, 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 파싱 실패' } }));
  }

  // 알림(id 없음)은 응답 본문이 없다
  const list = Array.isArray(msg) ? msg : [msg];
  const replies = [];
  for (const m of list) {
    if (m?.id === undefined || m?.id === null) continue;
    if (m?.method === 'tools/call') console.log(`호출 · ${pass.who} · ${m?.params?.name}`);
    replies.push(await handleRpc(m));
  }
  if (!replies.length) return res.writeHead(202, CORS).end();

  res
    .writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
    .end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`서버 시작 · 포트 ${PORT} · 접근 열쇠 ${KEYS.size ? `${KEYS.size}개 등록` : '없음(공개)'}`);
  ensureIndex().catch((e) => console.error('인덱스 최초 적재 실패:', e.message));
});
