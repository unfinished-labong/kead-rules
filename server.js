// 공단 규정 MCP 서버
// 인덱스를 깃허브에서 받아 메모리에 주소록(역색인)을 만들고, 조문을 찾아 돌려준다.
// 외부 라이브러리 없이 Node 기본 기능만 쓴다.

import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const INDEX_URL = process.env.INDEX_URL;          // data/index.json 의 raw 주소
const REFRESH_MS = Number(process.env.REFRESH_MIN ?? 60) * 60 * 1000;
const MAX_TEXT = 1800;                            // 조문 하나를 돌려줄 때 최대 글자 수
const MAX_FULL_CHARS = 40000;                     // 전문을 한 번에 내보낼 때의 한 쪽 분량
const DEBUG = process.env.DEBUG_SEARCH === '1';   // 점수를 눈으로 보고 문턱을 맞출 때 켠다

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

// 깃허브가 잠시 죽어도 예전 자료로 답할 수 있도록 받을 때마다 디스크에 복사해 둔다.
// 기기가 새로 만들어지면 사라지지만, 재시작이나 깃허브 장애에는 도움이 된다.
const CACHE_PATH = process.env.INDEX_CACHE ?? path.join(process.cwd(), 'index-cache.json');

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

  let raw = null;
  let etag = null;
  let source = '원격';

  try {
    const res = await fetch(INDEX_URL, { headers, signal: AbortSignal.timeout(20000) });
    if (res.status === 304) {
      console.log('인덱스 변화 없음 (304)');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    etag = res.headers.get('etag');
    raw = await res.text();
    // 다음 장애에 대비해 받은 그대로 남겨 둔다
    writeFile(CACHE_PATH, raw, 'utf-8').catch((e) => console.warn(`캐시 저장 실패: ${e.message}`));
  } catch (e) {
    console.error(`원격 인덱스 실패: ${e.message}`);
    if (STATE) {
      console.log('이미 올라온 인덱스를 그대로 씁니다.');
      return;                                   // 갱신 실패는 조용히 넘어간다
    }
    try {
      raw = await readFile(CACHE_PATH, 'utf-8');
      source = '로컬 캐시';
      console.warn('로컬 캐시로 기동합니다. 자료가 최신이 아닐 수 있습니다.');
    } catch {
      throw new Error('원격 인덱스도 로컬 캐시도 읽지 못했습니다.');
    }
  }

  const idx = JSON.parse(raw);
  if (!force && STATE && idx.builtAt === STATE.idx.builtAt) {
    if (etag) STATE.etag = etag;
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
    etag: etag ?? STATE?.etag,
    source,
    docs,
    articles,
    postings,
    lens,
    N: articles.length,
    loadedAt: new Date().toISOString(),
  };
  console.log(
    `인덱스 적재(${source}): 문서 ${docs.size} / 조문 ${articles.length} / 색인어 ${postings.size} / ${Date.now() - t0}ms`
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
const MIN_COVERAGE = 0.20;   // 겹침 비율. 조각 개수가 아니라 희소성으로 잰다
const MIN_SCORE = 8;         // 실측: 정상 질문 11~77점, 무관한 질문 0~4점

// 규정이 쓰는 말과 사람이 쓰는 말이 다른 경우를 이어준다.
// 규정에는 '경조사'라고만 적혀 있는데 사람은 '친족 사망'이라고 묻는다.
// 확장된 낱말은 순위에만 반영되고 겹침 계산에는 넣지 않는다. 잘못 넓혀도 손해가 없도록.
const SYNONYMS = [
  ['민간훈련기관', '위탁훈련기관', '민간위탁'],
  ['경조사', '친족', '사망', '결혼', '혼인', '출산', '부고', '조의',
   '상주', '초상', '장례', '별세', '타계', '조부모', '외조부모', '형제자매',
   '큰아버지', '작은아버지', '삼촌', '백부', '숙부', '고모', '이모', '조카',
   '할아버지', '할머니', '아버지', '어머니', '부모', '배우자', '자녀', '인척', '혈족'],
  ['휴가', '휴무', '연차', '월차'],
  ['강사료', '강의료'],
  ['출퇴근', '통근'],
  ['보조공학기기', '보조기기'],
  ['지도점검', '점검', '감독'],
  ['제출서류', '구비서류', '첨부서류'],
];

// 낱말 → 같은 무리의 다른 낱말들
const SYN_MAP = new Map();
for (const group of SYNONYMS) {
  for (const w of group) {
    const key = normText(w);
    const others = group.filter((x) => x !== w).map(normText);
    SYN_MAP.set(key, (SYN_MAP.get(key) ?? []).concat(others));
  }
}

function expandGrams(qn) {
  const extra = new Set();
  for (const [word, others] of SYN_MAP) {
    if (!qn.includes(word)) continue;
    for (const o of others) for (const g of grams(o)) extra.add(g);
  }
  return extra;
}


// ── 문서 성격 ──────────────────────────────────────────────
// 한 가지 질문의 답은 보통 규정 하나, 규칙 하나, 법령 하나에 나뉘어 담긴다.
// 그래서 조문을 바로 고르지 않고 성격마다 문서를 하나씩 먼저 확정한다.
// 법령은 index 의 kind 를 쓰고, 내부규정은 kind 가 비어 있어 이름 끝으로 가른다.
const NAME_KIND = [
  [/정관$/, '정관'],
  [/(시행규칙|업무처리\s*규칙|처리규칙|운영규칙|규칙)$/, '규칙'],
  [/(시행세칙|세칙)$/, '규칙'],
  [/규정$/, '규정'],
  [/(지침|예규|요령|준칙)$/, '지침'],
  [/강령$/, '강령'],
];

function docKind(d) {
  if (d.kind) return /부령$/.test(d.kind) ? '부령' : d.kind;   // 법률·대통령령·부령·고시·훈령
  for (const [re, k] of NAME_KIND) if (re.test(d.name)) return k;
  return '기타';
}

// 조문 점수를 문서 단위로 합산한다. 상위 3개만 더해서 조문이 많은 문서가 그냥 이기지 않게 한다.
function scoreDocs(hits) {
  // 문서가 무엇에 관한 것인지는 본칙이 정한다. 별표·부칙은 부속 자료라 문서 선정에서 뺀다.
  // (조문을 고르는 3단계에서는 그대로 다 본다.)
  const main = hits.filter((a) => a.section === '본칙');
  const use = main.length ? main : hits;
  const byDoc = new Map();
  for (const a of use) {
    if (!byDoc.has(a.docId)) byDoc.set(a.docId, []);
    byDoc.get(a.docId).push(a._score ?? 0);
  }
  const rows = [];
  for (const [docId, arr] of byDoc) {
    const d = STATE.docs.get(docId);
    if (!d) continue;
    arr.sort((x, y) => y - x);
    const sc = (arr[0] ?? 0) + 0.3 * (arr[1] ?? 0) + 0.15 * (arr[2] ?? 0);
    rows.push({ docId, name: d.name, kind: docKind(d), score: sc, n: arr.length });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

// 성격마다 1등을 고른다. 1등이 2등의 2배에 못 미치면 사용자에게 물어야 한다.
function pickDocs(rows) {
  if (!rows.length) return { picked: [], ambiguous: null };
  const byKind = new Map();
  for (const r of rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }
  // 되묻기는 '전체 1등이 걸린 성격'에서만 한다.
  // 관계없는 성격에서 1·2등이 붙어 있다고 답 전체를 막으면, 이미 정해진 답까지 못 준다.
  const leadKind = rows[0]?.kind;
  const picked = [];
  let ambiguous = null;
  for (const [kind, list] of byKind) {
    const [top, second] = list;
    const close = second && top.score < second.score * 2;
    // 되묻는 건 값이 클 때만이다. 세 조건을 모두 만족해야 사용자를 붙든다.
    //  · 전체 1등이 걸린 성격일 것            (엉뚱한 성격의 접전은 답을 막을 이유가 없다)
    //  · 1등 점수가 충분히 높을 것            (약한 후보끼리의 접전은 물어도 답이 안 나온다)
    //  · 형제 문서가 아닐 것                  (규정↔규칙은 어차피 형제 안내가 챙긴다)
    // 후보가 둘뿐이면 굳이 붙들지 않는다. 둘 다 열어두면 조문 점수가 알아서 가린다.
    // 셋 이상이 엉겨 붙었을 때만, 그때는 좁힐 방법이 없으므로 사용자에게 묻는다.
    const third = list[2];
    const crowded = third && top.score < third.score * 2;
    const worthAsking =
      close &&
      crowded &&
      kind === leadKind &&
      top.score >= MIN_SCORE * 3 &&
      familyKey(top.name) !== familyKey(second.name);
    if (worthAsking) {
      ambiguous = { kind, top, second, rest: list.slice(2, 10) };
    } else if (close) {
      picked.push(top, second);        // 애매하면 둘 다 열어두고 점수가 가리게 한다
    } else {
      picked.push(top);
    }
  }
  return { picked, ambiguous };
}

function search(query, { scope, section, document, onlyDocIds, relaxed, limit = MAX_HITS } = {}) {
  const S = STATE;
  const qn = normText(query);
  if (qn.length < 2) return [];

  const qg = [...new Set(grams(qn))];
  const qset = new Set(qg);
  const extra = [...expandGrams(qn)].filter((g) => !qset.has(g));

  const scores = new Map();
  const hitIdf = new Map();          // 겹친 조각의 희소성 합
  let totalIdf = 0;                  // 질의 전체 조각의 희소성 합

  const collect = (list, weight, isOriginal) => {
    for (const g of list) {
      const post = S.postings.get(g);
      if (!post) continue;
      const idf = Math.log(1 + S.N / post.length);
      if (isOriginal) totalIdf += idf;        // 분모는 원래 질의로만 잡는다
      if (post.length > S.N * 0.4) continue;
      for (const i of post) {
        scores.set(i, (scores.get(i) ?? 0) + idf * weight);
        hitIdf.set(i, (hitIdf.get(i) ?? 0) + idf * weight);
      }
    }
  };
  collect(qg, 1, true);
  collect(extra, 0.5, false);        // 바꿔 찾은 말은 절반만 쳐준다

  if (!scores.size || totalIdf === 0) return [];

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

  // 특정 규정 안에서만 찾도록 한정할 수 있다
  let onlyDocs = onlyDocIds ?? null;
  if (!onlyDocs && document) {
    const dq = normText(document);
    onlyDocs = new Set([...S.docs.values()].filter((d) => normText(d.name).includes(dq)).map((d) => d.docId));
  }

  const out = [];
  for (const [i, raw] of scores) {
    const a = S.articles[i];
    if (onlyDocs && !onlyDocs.has(a.docId)) continue;
    if (scope === '법제처' && !a.docId.startsWith('법령:')) continue;
    if (scope === '내부규정' && !a.docId.startsWith('내규:')) continue;
    if (section && a.section !== section) continue;

    const cov = (hitIdf.get(i) ?? 0) / totalIdf;        // 흔한 조각 여러 개보다 드문 조각 하나를 무겁게
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
  const floor = document || relaxed ? MIN_SCORE * 0.3 : MIN_SCORE;
  let passed = out.filter((o) => o.s >= floor);
  // 아무것도 문턱을 못 넘으면 빈손으로 돌려보내지 않는다.
  // '못 찾았다'와 '없다'는 다르다. 근거가 약한 후보라도 보여주고 약하다고 밝히는 편이,
  // 모델이 "규정에 없습니다"라고 단정해버리는 것보다 낫다.
  let weak = false;
  if (!passed.length) {
    passed = out.filter((o) => o.s >= floor * 0.2).slice(0, Math.max(limit, 5));
    weak = passed.length > 0;
  }
  if (DEBUG) {
    console.error(`[검색] "${query}" / 조각 ${qg.length} · 확장 ${extra.length} / 문턱 ${floor.toFixed(1)}`);
    for (const o of out.slice(0, 8)) {
      const a = S.articles[o.i];
      const cov = (hitIdf.get(o.i) ?? 0) / totalIdf;
      console.error(`  ${o.s >= floor ? '\u25cb' : '\u00d7'} ${o.s.toFixed(1)}점 cov=${cov.toFixed(2)} ${S.docs.get(a.docId)?.name ?? '?'} ${a.articleId}`);
    }
  }
  return passed.slice(0, limit).map(({ i, s }) => ({ ...S.articles[i], _score: s, _weak: weak }));
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
  `LLM 주의: 이것은 "자료에 없다"가 아니라 "이 검색어로는 못 찾았다"는 뜻입니다. ` +
  `아직 "규정에 없습니다"라고 답하지 마십시오. 조문을 지어내지도 마십시오.\n` +
  `사용자가 쓰는 말과 규정의 용어가 다를 때 이렇게 됩니다. 일상어를 규정 용어로 바꿔 다시 검색하십시오.\n` +
  `  큰아버지·삼촌·조카 → 친족, 형제자매, 경조사 / 상주·초상·장례 → 경조사, 사망\n` +
  `  월급·수당 → 보수 / 출장비 → 여비 / 서류 → 제출서류, 구비서류\n` +
  `그래도 안 나오면 list_documents 로 수록 범위를 확인하고, 관련 규정을 골라 ` +
  `get_provision 의 목차나 전문으로 직접 훑어본 뒤에 판단하십시오.` +
  (hint ? `\n참고: ${hint}` : '');

function footer() {
  return `\n---\n자료 기준일: ${STATE.idx.dataAsOf} · 수록 문서 ${STATE.docs.size}건 / 조문 ${STATE.N}건`;
}

// ── 형제 문서 ──────────────────────────────────────────────
// 같은 사안을 규정과 규칙이 나눠 담는 일이 흔하다.
// 다만 안내는 '흩어진 사안을 묻는 질문'에만 붙인다.
// 조문 하나를 콕 집어 묻는 질문에까지 붙이면 답이 흐려진다.
const DOC_SUFFIX = /(시행규칙|업무처리규칙|업무처리지침|업무규칙|처리규칙|운영규칙|시행세칙|시행규정|세칙|규칙|규정|지침|준칙|예규|요령|정관)$/;

function familyKey(name) {
  let s = normText(name);
  for (let i = 0; i < 4; i++) {
    const t = s.replace(DOC_SUFFIX, '');
    if (t === s) break;
    s = t;
  }
  return s.length >= 2 ? s : null;      // '복무규정'→'복무'처럼 줄기가 짧은 규정이 많다
}

function families() {
  if (STATE.families) return STATE.families;
  const m = new Map();
  for (const d of STATE.docs.values()) {
    const k = familyKey(d.name);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(d);
  }
  for (const [k, v] of m) if (v.length < 2) m.delete(k);
  STATE.families = m;
  return m;
}

function artCount(docId) {
  if (!STATE.counts) {
    STATE.counts = new Map();
    for (const a of STATE.articles) STATE.counts.set(a.docId, (STATE.counts.get(a.docId) ?? 0) + 1);
  }
  return STATE.counts.get(docId) ?? 0;
}

function siblingNotice(shownDocIds) {
  const fam = families();
  const shown = new Set(shownDocIds);
  const seenKey = new Set();
  const rows = [];
  for (const id of shown) {
    const d = STATE.docs.get(id);
    if (!d) continue;
    const k = familyKey(d.name);
    if (!k || seenKey.has(k)) continue;
    seenKey.add(k);
    for (const o of fam.get(k) ?? []) {
      if (!shown.has(o.docId)) rows.push(`  \u00b7 ${o.name} (조문 ${artCount(o.docId)}건)`);
    }
  }
  if (!rows.length) return '';
  return (
    `\n\n※ 같은 사안을 나눠 담은 문서가 더 있습니다. 아직 확인하지 않았습니다.\n` +
    [...new Set(rows)].join('\n') +
    `\n한쪽에 없다고 "없다"로 끝내지 마십시오.`
  );
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
      '표준사업장, 인사, 복무, 징계, 휴가, 감사, 계약, 위탁, 제출서류, ' +
      '민간훈련기관, 공공훈련기관, 위탁훈련기관, 훈련과정, 훈련생, 훈련수당, 지도점검, 운영평가, ' +
      '실시상황보고, 구직등록, 취업지원, 사후관리, 직업능력평가, 고용장려금, 부담기초액, 연계고용, ' +
      '출퇴근비용, 직업생활상담원, 기능경기대회, 정보공개, 기록물, 안전보건, 성과관리, 청렴, 행동강령.\n' +
      '【답변 규칙】 이 도구가 돌려준 조문에 실제로 적힌 내용만 근거로 삼는다. ' +
      '결과가 [NOT_FOUND]이면 추측하지 말고 "수록된 규정에서 근거를 찾지 못했다"고 답한다. ' +
      '한 번에 못 찾으면 다른 낱말로 2~3회 더 시도한 뒤에 판단한다.\n' +
      '【흩어진 의무를 묻는 질문】 "분기별로 뭘 해야 하나", "제출서류가 뭐가 있나"처럼 답이 여러 조문에 흩어진 질문은 ' +
      '한 번 검색으로 끝내지 말 것. 먼저 관련 규정을 찾고, get_provision 으로 그 규정의 목차를 받아 ' +
      '조문 제목을 훑은 뒤, document 를 지정해 그 규정 안에서 핵심 낱말(분기, 반기, 보고, 제출, 점검, 평가 등)로 다시 검색한다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '찾고자 하는 내용. 예: 부담기초액, 근로지원인 신청 절차, 인사규정 제5조' },
        scope: { type: 'string', enum: ['전체', '내부규정', '법제처'], description: '검색 범위. 기본값 전체' },
        section: { type: 'string', enum: ['본칙', '부칙', '별표'], description: '특정 구분만 볼 때. 기본은 전체이며 본칙이 우선 노출됨' },
        document: { type: 'string', description: '이 규정 안에서만 찾는다. 문서명 일부면 된다. 예: 장애인 직업능력개발훈련 지원규정' },
        limit: { type: 'number', description: '결과 개수. 기본 8, 최대 15' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_provision',
    description:
      '문서명과 조문번호를 알 때 그 조문의 원문을 그대로 가져온다. 예: 인사규정 시행규칙 제5조, 교육훈련규칙 [별표 4].\n' +
      '사용자가 특정 조문이나 별표를 지목했다면 검색보다 이 도구를 먼저 쓴다. 원문을 고치거나 요약하지 말고 그대로 인용한다.\n' +
      "article 을 비우거나 '목차'로 주면 그 규정의 전체 조문 목록(번호와 제목)을 돌려준다. " +
      '어떤 조문이 있는지 훑어보고 필요한 것을 고를 때 쓴다. 검색어가 안 맞아 조문을 놓치는 것을 막는 가장 확실한 방법이다.\n' +
      'article="전문" 으로 주면 그 규정을 처음부터 끝까지 본문째로 돌려준다. 분량이 많으면 쪽으로 나뉘며, '
      + '그때는 "전문2", "전문3" 으로 끝까지 이어서 읽는다.\n'
      + '【여러 조문에 걸친 질문일 때만】 체크리스트·제출서류·주기별 의무처럼 답이 흩어진 질문은 목차 제목만 보고 고르지 말고 '
      + '전문을 끝까지 읽는다. 관련 없다고 빼는 조문은 왜 뺐는지 한 줄로 밝힌다. '
      + '조문 하나를 묻는 질문에는 해당하지 않으니, 그때는 그 조문만 확인하고 바로 답한다.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: '규정 이름. 일부만 적어도 된다. 예: 인사규정 시행규칙' },
        article: { type: 'string', description: "조문번호. 예: 제5조, 제12조의2, 전문. 비우거나 '목차'라고 하면 그 규정의 조문 목록 전체를 돌려준다" },
      },
      required: ['document'],
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
    const q = String(args.query ?? '');

    // 문서를 이미 지정했으면 예전 그대로 그 안에서만 찾는다
    if (args.document) {
      const hits = search(q, { scope, section: args.section, document: args.document, limit });
      if (!hits.length) return NOT_FOUND(`"${q}" 로 검색된 조문이 없습니다.`, `"${args.document}" 안에서 찾았습니다. 다른 규정일 수 있습니다.`);
      return (
        `검색어: ${q} · ${args.document} 안 · ${hits.length}건\n\n` +
        hits.map((a) => renderArticle(a)).join('\n\n') +
        footer()
      );
    }

    // 조문을 콕 집어 물었으면 문서를 고를 것도 없다. 예전 경로 그대로.
    if (/제\s*\d+\s*조/.test(q)) {
      const hits = search(q, { scope, section: args.section, limit });
      if (hits.length) {
        return (
          `검색어: ${q} · ${hits.length}건\n\n` +
          hits.map((a) => renderArticle(a)).join('\n\n') +
          footer()
        );
      }
    }

    // 1단계: 전체를 훑어 어느 문서인지부터 정한다
    const wide = search(q, { scope, section: args.section, limit: 60 });
    if (!wide.length) {
      return NOT_FOUND(`"${q}" 로 검색된 조문이 없습니다.`, 'list_documents 로 수록 범위를 확인해 보십시오.');
    }

    // 1단계부터 근거가 약하면 문서를 정할 자격이 없다. 약하다고 밝히고 그대로 내보낸다.
    if (wide[0]?._weak) {
      const w = wide.slice(0, limit);
      return (
        `[약한 결과] 검색어: ${q}\n` +
        `문턱을 넘은 조문이 없어, 점수가 낮은 후보 ${w.length}건을 그대로 보여줍니다.\n` +
        `LLM 주의: 아래 조문은 질문과 무관할 수 있습니다. 그렇다고 "규정에 없다"고 답하지 마십시오.\n` +
        `질문의 말과 규정의 용어가 어긋났을 가능성이 큽니다. 용어를 바꿔 다시 검색하거나, ` +
        `관련 규정을 골라 get_provision 의 목차·전문으로 직접 확인한 뒤에 답하십시오.\n\n` +
        w.map((a) => renderArticle(a)).join('\n\n') +
        footer()
      );
    }

    const rows = scoreDocs(wide);
    const { picked, ambiguous } = pickDocs(rows);

    // 2단계: 성격 안에서 1등과 2등이 엇비슷하면 고르지 않고 되묻는다
    if (ambiguous) {
      const a = ambiguous;
      const line = (r, i) => `  ${i}. ${r.name} (조문 ${artCount(r.docId)}건 · 관련 조문 ${r.n}건)`;
      return (
        `[선택 필요] 검색어: ${q}\n` +
        `${a.kind} 중 두 문서가 비슷하게 걸립니다. 어느 쪽인지 사용자에게 물어보십시오.\n` +
        `추측해서 하나를 고르지 마십시오.\n\n` +
        line(a.top, 1) + '\n' + line(a.second, 2) + '\n' +
        `  3. 둘 다 아님 — 아래 다른 후보를 보여주십시오.\n` +
        (a.rest.length ? `\n다른 후보: ${a.rest.map((r) => r.name).join(' / ')}\n` : '\n') +
        (picked.length ? `\n참고로 다른 성격에서는 이미 정해졌습니다: ${picked.map((r) => `${r.kind}=${r.name}`).join(', ')}\n` : '') +
        `\n사용자가 고르면 search_provisions 를 document 에 그 이름을 넣어 다시 부르십시오.` +
        footer()
      );
    }

    // 3단계: 정해진 문서 안에서만 다시 찾는다. 범위가 좁으니 문턱을 낮춘다.
    const onlyDocIds = new Set(picked.map((r) => r.docId));
    let hits = search(q, { scope, section: args.section, onlyDocIds, relaxed: true, limit });
    let narrowed = true;
    if (!hits.length) { hits = wide.slice(0, limit); narrowed = false; }   // 좁히다 놓치면 1단계로 되돌아간다

    const head =
      `검색어: ${q} · ${hits.length}건\n` +
      (narrowed
        ? `문서를 먼저 정하고 그 안에서 찾았습니다: ${picked.map((r) => `${r.kind}=${r.name}`).join(', ')}\n` +
          (picked.length > new Set(picked.map((r) => r.kind)).size
            ? `같은 성격에서 비슷한 문서가 있어 양쪽을 다 살폈습니다. 답이 한쪽에만 있다면 그 문서명을 함께 밝히십시오.\n`
            : '')
        : `문서를 좁히지 못해 전체 결과를 보여줍니다.\n`) +
      `아래 조문에 실제로 적힌 내용만 근거로 답하고, 인용할 때는 문서명과 조문번호를 함께 밝히십시오.\n` +
      (hits[0]?._weak ? `※ 점수가 낮은 후보입니다. 무관할 수 있으나, 그렇다고 "규정에 없다"고 답하지는 마십시오.\n` : '') +
      `\n`;

    const pinpoint = /제\s*\d+\s*조/.test(q) || hits.length <= 2;
    return (
      head +
      hits.map((a) => renderArticle(a)).join('\n\n') +
      (pinpoint ? '' : siblingNotice(hits.map((a) => a.docId))) +
      footer()
    );
  }

  if (name === 'get_provision') {
    const dq = normText(args.document);
    const cands = [...STATE.docs.values()].filter((d) => normText(d.name).includes(dq));
    if (!cands.length) return NOT_FOUND(`"${args.document}" 이라는 규정을 찾지 못했습니다.`, 'list_documents 로 이름을 확인하십시오.');

    const sorted = [...cands].sort((a, b) => a.name.length - b.name.length);
    const want = String(args.article ?? '').replace(/\s/g, '');
    const browsing = !want || want === '목차' || want === '전체' || /^(전문|본문|전체본문)\d*$/.test(want);

    // 이름이 겹칠 때 조용히 하나를 고르지 않는다.
    // 조문을 콕 집어 물은 경우는 한 줄로만 알리고, 훑어보는 경우는 목록을 보여준다.
    const multi =
      cands.length < 2
        ? ''
        : browsing
          ? `※ 이름이 겹치는 문서가 ${cands.length}건입니다. 그중 하나만 아래에 보여줍니다.\n` +
            sorted.map((d) => `  · ${d.name} (조문 ${artCount(d.docId)}건)`).join('\n') +
            `\n나머지도 확인해야 합니다. document 에 이름을 더 정확히 적어 다시 부르십시오.\n\n`
          : '';

    // 목차
    if (!want || want === '목차' || want === '전체') {
      const d = sorted[0];
      const list = STATE.articles.filter((x) => x.docId === d.docId);
      const line = (x) => `  ${x.articleId}${x.title ? ` (${x.title})` : ''}${x.needsOriginal ? ' ※표·별표 포함' : ''}`;
      const bySec = ['본칙', '부칙', '별표']
        .map((sec) => {
          const rows = list.filter((x) => x.section === sec);
          return rows.length ? `[${sec}] ${rows.length}건\n` + rows.map(line).join('\n') : null;
        })
        .filter(Boolean);
      return (
        multi +
        `■ ${d.name} 조문 목록\n` +
        `  시행 ${d.effectiveDate ?? '표기 없음'}${d.lawNo ? ` · 제${d.lawNo}호` : ''} · ${d.source}\n` +
        `  원문: ${d.originalUrl}\n\n` +
        bySec.join('\n\n') +
        `\n\n제목만 본 것입니다. 내용까지 한 번에 보려면 article="전문", 특정 조문만 보려면 article="제○조" 로 다시 부르십시오.` +
        siblingNotice([d.docId]) +
        footer()
      );
    }

    // 전문: 문서 하나를 처음부터 끝까지. 길면 쪽으로 나눈다.
    if (/^(전문|본문|전체본문)\d*$/.test(want)) {
      const d = sorted[0];
      const list = STATE.articles.filter((x) => x.docId === d.docId);
      if (!list.length) return NOT_FOUND(`"${d.name}" 에 수록된 조문이 없습니다.`);

      const pages = [];
      let cur = [];
      let used = 0;
      for (const a of list) {
        const size = Math.min(String(a.text ?? '').length, MAX_TEXT) + 60;
        if (cur.length && used + size > MAX_FULL_CHARS) { pages.push(cur); cur = []; used = 0; }
        cur.push(a);
        used += size;
      }
      if (cur.length) pages.push(cur);

      const p = Math.min(Math.max(Number((want.match(/\d+/) ?? ['1'])[0]) || 1, 1), pages.length);
      const rows = pages[p - 1];
      const clipped = rows.filter((a) => String(a.text ?? '').length > MAX_TEXT).length;
      const body = rows
        .map((a) => `■ ${a.articleId}${a.title ? ` (${a.title})` : ''}${a.section !== '본칙' ? ` [${a.section}]` : ''}\n` + clip(a.text))
        .join('\n\n');
      const nav =
        pages.length > 1
          ? `\n\n이 쪽은 ${p}/${pages.length} 입니다. 여기서 멈추지 말고 article="전문${p + 1}" 로 나머지를 마저 읽으십시오.`
          : `\n\n이 문서는 여기까지가 전부입니다.`;

      return (
        multi +
        `■ ${d.name} 전문 (${p}/${pages.length}쪽) · 이 쪽 ${rows.length}건 / 전체 ${list.length}건\n` +
        `  시행 ${d.effectiveDate ?? '표기 없음'}${d.lawNo ? ` · 제${d.lawNo}호` : ''} · ${d.source}\n` +
        `  원문: ${d.originalUrl}\n` +
        (clipped ? `  ※ 이 쪽에서 ${clipped}건이 길이 때문에 잘렸습니다. 해당 조문은 원문을 확인하십시오.\n` : '') +
        `\n조문을 하나씩 끝까지 읽고, 관련 없다고 넘긴 조문은 넘긴 이유를 한 줄로 밝히십시오.\n\n` +
        body +
        nav +
        (p === pages.length ? siblingNotice([d.docId]) : '') +
        footer()
      );
    }

    // 조문 하나를 콕 집어 물은 경우: 군더더기 없이 그 조문만 돌려준다
    for (const d of cands) {
      const a = STATE.articles.find((x) => x.docId === d.docId && x.articleId.replace(/\s/g, '') === want);
      if (a) return renderArticle(a) + footer();
    }
    const ids = STATE.articles
      .filter((x) => x.docId === sorted[0].docId && x.section === '본칙')
      .map((x) => x.articleId);
    return NOT_FOUND(
      `"${sorted[0].name}" 에 ${args.article} 이(가) 없습니다.`,
      `수록된 조문: ${ids.slice(0, 40).join(', ')}${ids.length > 40 ? ' …' : ''}` +
        (cands.length > 1 ? ` / 이름이 겹치는 문서: ${sorted.map((d) => d.name).join(', ')}` : '')
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
    if (STATE) {
      body.keyRequired = KEYS.size > 0;
      body.source = STATE.source;          // '원격' 또는 '로컬 캐시'
    }
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
