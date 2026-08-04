// 공단 규정 MCP 서버
// 인덱스를 깃허브에서 받아 메모리에 주소록(역색인)을 만들고, 조문을 찾아 돌려준다.
// 외부 라이브러리 없이 Node 기본 기능만 쓴다.

import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const INDEX_URL = process.env.INDEX_URL;          // data/index.json 의 raw 주소
const REFRESH_MS = Number(process.env.REFRESH_MIN ?? 60) * 60 * 1000;
// 조문 하나를 돌려줄 때의 최대 글자 수. 구분마다 사정이 다르다.
//  · 별표는 표가 통째로 들어 있어 중간에서 끊으면 뒷줄 항목이 아예 안 보인다.
//    색인 자체가 12,000자에서 잘리므로 그만큼 열어두면 더 잃을 것이 없다.
//  · 부칙에도 별지 서식이 붙는 경우가 있어 넉넉히 준다.
//  · 본칙은 가장 긴 것이 5,217자라 6,000이면 잘릴 일이 없다.
const TEXT_CAP = { 본칙: 6000, 별표: 12000, 부칙: 12000 };
const MAX_TEXT = 12000;                           // 상한의 최대치. 전문 쪽 나누기에서 참고한다.
const capOf = (section) => TEXT_CAP[section] ?? 6000;
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
let PUBLIC_BASE = process.env.PUBLIC_URL ?? '';   // 요청 Host 에서 자동으로 채운다
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




// ── 원문 뷰어 ──────────────────────────────────────────────
// 현장에서 바로 확인하려면 링크를 눌렀을 때 브라우저에서 열려야 한다.
// 공단 게시판 링크는 한글 파일을 내려받게 하고, 법제처 한글주소는 조문으로 못 간다.
// 인덱스에 이미 전문과 표(HTML)가 다 있으므로, 그것을 그대로 그려서 내보낸다.
// 한글 문서명을 그대로 주소에 쓰면 퍼센트 인코딩 때문에 링크 하나가 160자를 넘고,
// 긴 것은 338자까지 간다. 답변 곳곳에 붙이면 그것만으로 컨텍스트를 먹는다.
// 게다가 모델이 긴 주소를 옮겨 적다가 깨뜨리는 일이 실제로 있었다(법제처 한글주소).
// 그래서 짧은 키를 따로 만들어 쓴다. /doc/<한글이름> 도 그대로 열리므로 사람이 손으로 쳐도 된다.
function slugOf(docId) {
  if (!STATE.slugs) {
    STATE.slugs = new Map();
    STATE.byslug = new Map();
    for (const id of [...STATE.docs.keys()].sort()) {
      let h = 5381;
      for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
      let k = h.toString(36).slice(0, 4);
      let n = 0;
      while (STATE.byslug.has(k)) k = (h.toString(36).slice(0, 4) + (++n).toString(36));
      STATE.slugs.set(id, k);
      STATE.byslug.set(k, id);
    }
  }
  return STATE.slugs.get(docId);
}

// 문서 하나를 여는 짧은 주소. 조문을 주면 그 자리로 바로 간다.
function viewUrl(docId, articleId) {
  if (!PUBLIC_BASE) return null;
  const k = slugOf(docId);
  if (!k) return null;
  return `${PUBLIC_BASE}/d/${k}${articleId ? `#${anchorOf(articleId)}` : ''}`;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 조문 본문에는 표가 HTML 로 들어 있다. 표 관련 태그만 살리고 나머지는 글자로 취급한다.
const KEEP_TAG = /&lt;(\/?(?:table|thead|tbody|tr|th|td|br|p)(?:\s+(?:colspan|rowspan)="\d+")*)\s*\/?&gt;/gi;
// 법제처 별표는 ┏━┓┃│ 같은 괘선 문자로 그린 표인데, 수집 과정에서 줄바꿈이 사라진다.
// 줄 끝은 ┓ ┨ ┛ 또는 '닫는 ┃'(뒤에 ┃ ┠ ┗ 가 오는 것)이므로 그 자리를 되살린다.
// 되살린 뒤 고정폭 글꼴로 그리면 원본 표가 그대로 재현된다.
const BOX = /[┏┓┗┛┠┨┯┷┼━─│┃]/;
function restoreBoxTable(t) {
  return String(t ?? '')
    .replace(/([┓┛┨┫])/g, '$1\n')
    .replace(/┃(?=[┃┠┗])/g, '┃\n')
    .replace(/(?=┏)/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function bodyHtml(text) {
  const raw = String(text ?? '');
  if (BOX.test(raw) && !/<table/i.test(raw)) {
    // 괘선 표는 손대지 않고 통째로 고정폭으로 보여준다. 칸을 다시 재면 어긋난다.
    return `<pre class="box">${esc(restoreBoxTable(raw))}</pre>`;
  }
  return esc(raw)
    .replace(KEEP_TAG, '<$1>')
    .replace(/&lt;img[^&]*?src=&quot;(https?:\/\/[^&"]+)&quot;[^&]*?&gt;/gi, '<img src="$1" alt="">')
    .replace(/\n/g, '<br>');
}

// 별표·별지인가. 별지는 대부분 신청서·보고서 서식이라 본문을 보여줄 값어치가 없다.
const isForm = (id) => /별지|서식/.test(String(id ?? ''));

// 목차에 쓸 짧은 이름.
// 실제 값은 '[별지 제33호 서식] (제5조의2 관련) [신설 2021. 4. 5.]' 처럼 길어서,
// 그대로 늘어놓으면 목차가 개정 이력으로 뒤덮인다. 종류와 번호만 남긴다.
function shortLabel(articleId) {
  const t = String(articleId ?? '');
  const m = t.match(/(별표|별지|서식)\s*(?:제)?\s*(\d+(?:의\d+)?)/);
  if (m) return `${m[1] === '서식' ? '별지' : m[1]} ${m[2]}`;
  if (/^\[?(별표|별지|서식)/.test(t)) return t.replace(/[[\]()<>]/g, '').split(/\s+/).slice(0, 2).join(' ');
  return t;
}

// 앵커는 사람이 손으로 칠 수 있게 단순한 형태로 만든다. 제25조 → 제25조, [별표 2] → 별표2
function anchorOf(articleId) {
  const t = String(articleId ?? '').replace(/\s/g, '');
  const b = t.match(/^\[별표(\d+[^\]]*)\]/);
  if (b) return `별표${b[1].replace(/[^0-9의-]/g, '')}`;
  const j = t.match(/^(제\d+조(?:의\d+)?)/);
  if (j) return j[1];
  return encodeURIComponent(t).slice(0, 40);
}

const VIEW_CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:1rem 1rem 4rem;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;
 max-width:52rem;margin-inline:auto;word-break:keep-all;overflow-wrap:anywhere}
header{position:sticky;top:0;background:Canvas;padding:.6rem 0;border-bottom:2px solid CanvasText;margin-bottom:1rem;z-index:9}
h1{font-size:1.15rem;margin:0 0 .3rem}
.meta{font-size:.8rem;opacity:.75;line-height:1.5}
.toc{font-size:.82rem;margin:0 0 2rem;padding:.7rem .9rem;border:1px solid;border-radius:.5rem}
.toc summary{cursor:pointer;font-weight:600;opacity:.75;margin-bottom:.5rem}
/* 짧은 그룹만 통째로 지킨다. 긴 그룹(별표 21건·본칙 40건)까지 avoid 를 걸면
   열 하나에 갇혀 목차가 세로로 늘어진다. 헤더는 항상 뒤따르는 항목과 붙여 둔다. */
.tg{margin:0 0 .55rem;padding-left:.1rem}
.tg.short{break-inside:avoid}
/* 장은 절·조보다 한 단 크고 굵게. 뒤따르는 절과 떨어져 열 끝에 혼자 남지 않게 묶는다. */
.toc .jang{font-size:.95rem;font-weight:700;opacity:.85;margin:1.1rem 0 .3rem;
 padding-bottom:.15rem;border-bottom:1px solid;break-after:avoid;break-inside:avoid}
.toc .jang:first-child{margin-top:0}
.toc .jang+.tg b{margin-top:.25rem}
.tg b{display:block;font-size:.75rem;opacity:.6;margin:.5rem 0 .15rem;letter-spacing:.02em;
 break-after:avoid}
.toc a{display:block;text-decoration:none;line-height:1.4;padding:.05rem 0;opacity:.9;
 white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toc a i{font-style:normal;opacity:.5;display:inline-block;min-width:4.4rem;font-size:.75rem}
.toc a:hover{opacity:1;text-decoration:underline}
/* 별표·별지는 번호만 있어 짧다. 줄줄이 세우지 말고 칩처럼 흘려 담는다. */
.chips{display:flex;flex-wrap:wrap;gap:.25rem .4rem;align-items:baseline}
.chips b{flex:0 0 100%}
.toc a.chip{display:inline-block;border:1px solid;border-radius:.25rem;
 padding:.05rem .35rem;font-size:.75rem;opacity:.8}
.toc a.chip i{min-width:0;opacity:.85;font-size:.75rem}
.form h2{opacity:.75;font-weight:500}
/* 다단은 목차 전체에만 건다. 그룹 안에서 한 번 더 나누면 열 폭이 1/4로 줄어
   제목이 잘리고, 항목 두셋짜리 그룹은 헤더만 왼쪽 열에 남고 항목이 오른쪽 열로 떨어진다. */
@media(min-width:40rem){.toc{columns:2;column-gap:1.8rem}
 .tg{display:block}}
pre.box{font-family:"D2Coding","Nanum Gothic Coding","Menlo",ui-monospace,monospace;
 font-size:.72rem;line-height:1.35;white-space:pre;overflow-x:auto;margin:.6rem 0;
 padding:.6rem .7rem;border:1px solid;border-radius:.35rem;
 background:color-mix(in srgb,CanvasText 4%,transparent);tab-size:2}
.chap{font-weight:700;margin:1.6rem 0 .4rem;font-size:.9rem;opacity:.7}
.chap.top{font-size:1.05rem;opacity:.9;margin:2.4rem 0 .5rem;padding-top:.7rem;border-top:2px solid}
/* 앵커로 뛰면 조문 머리가 붙박이 머리말 밑에 깔린다. 머리말 높이는 제목 길이와
   화면 폭에 따라 달라져서(5~9rem) 고정값으로는 못 맞춘다. 아래 script 가 실측해
   --hdr 에 넣는다. :target 테두리가 .5rem 바깥으로 나가므로 그만큼 더 띄운다. */
article{margin:0 0 1.8rem;scroll-margin-top:calc(var(--hdr,7rem) + .9rem)}
article:target{background:color-mix(in srgb,Highlight 18%,transparent);
 outline:2px solid Highlight;outline-offset:.5rem;border-radius:.3rem}
h2{font-size:1rem;margin:0 0 .4rem;padding-top:.3rem}
h2 .no{opacity:.55;font-weight:400;font-size:.8rem;margin-left:.4rem}
.body{white-space:normal}
table{border-collapse:collapse;width:100%;margin:.7rem 0;font-size:.82rem;display:block;overflow-x:auto}
th,td{border:1px solid;padding:.3rem .45rem;vertical-align:top;min-width:3.5rem}
th{background:color-mix(in srgb,CanvasText 8%,transparent);font-weight:600}
img{max-width:100%;height:auto}
.top{position:fixed;right:1rem;bottom:1rem;padding:.55rem .8rem;border:1px solid;border-radius:2rem;
 background:Canvas;text-decoration:none;font-size:.8rem;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.warn{font-size:.8rem;padding:.5rem .8rem;border-left:3px solid;opacity:.85;margin:.5rem 0}
.src{font-size:.75rem;margin:.2rem 0 .4rem;opacity:.7}
`;

const noSpace = (s) => String(s ?? '').replace(/\s/g, '');
const JEOL_RE = /^제\s*\d+\s*[절관]/;

function renderDocHtml(d, list) {
  const secName = { 본칙: '', 부칙: '부칙', 별표: '별표·서식' };
  const parts = [];
  let curSec = null;
  let curChap = null;
  let curTop = null;
  let curStale = null;

  // 장·절 제목 줄은 '직전 조문 본문의 꼬리'에 붙어 있다(장은 build-index 가 그걸 읽어
  // chapterTop 을 만든다). 그대로 두면 머리글 바로 앞에 같은 글이 한 번 더 보인다.
  // 표시에서만 걷어낸다. 실제로 머리글로 쓰는 값과 맞을 때만 지우므로
  // '제2장의 규정에 따라…' 같은 본문 줄은 건드리지 않는다.
  const hasTop = list.some((a) => a.chapterTop);
  const heads = new Set(
    list.flatMap((a) => [noSpace(a.chapterTop), noSpace(a.chapter)]).filter(Boolean),
  );
  const stripHeads = (text) => {
    if (!heads.size) return text;
    return String(text ?? '')
      .split('\n')
      .filter((l) => {
        const n = noSpace(l);
        if (!/^제\d+[장절관편]/.test(n)) return true;
        for (const t of heads) if (n.startsWith(t)) return false;
        return true;
      })
      .join('\n');
  };

  for (const a of list) {
    if (a.section !== curSec) {
      curSec = a.section;
      curChap = null;
      curTop = null;
      if (secName[curSec]) parts.push(`<h2 class="chap" style="font-size:1rem;opacity:1">${esc(secName[curSec])}</h2>`);
    }
    if (a.section === '본칙' && a.chapterTop && a.chapterTop !== curTop) {
      curTop = a.chapterTop;
      curStale = curChap;                                    // 목차와 같은 판정(아래 주석 참고)
      curChap = null;
      parts.push(`<div class="chap top">${esc(a.chapterTop)}</div>`);
    }
    // 장은 바로 위 줄이 맡는다. breadcrumb 은 절·관일 때만, 그리고 앞 장에서 물고 온
    // 이월값이 아닐 때만 찍는다.
    const subOk = hasTop ? JEOL_RE.test(a.chapter ?? '') && a.chapter !== curStale : true;
    if (a.section === '본칙' && a.chapter && subOk && a.chapter !== curChap) {
      curChap = a.chapter;                                   // 빈 값이면 앞 장을 그대로 둔다
      curStale = null;
      parts.push(`<div class="chap">${esc(a.chapter)}</div>`);
    }
    const id = anchorOf(a.articleId);
    const link = a.link ?? d.originalUrl ?? null;
    // 별지는 거의 전부 신청서·보고서 서식이다. 글자로 옮겨 봐야 칸이 어긋나 읽기 어렵고,
    // 실제로 필요한 것은 내려받아 쓰는 일이다. 그래서 본문을 그리지 않고 링크만 준다.
    if (isForm(a.articleId)) {
      parts.push(
        `<article id="${esc(id)}" class="form">` +
        `<h2>${esc(shortLabel(a.articleId))}${a.title && a.title !== a.articleId ? ` ${esc(a.title)}` : ''}` +
        `<span class="no">#${esc(id)}</span></h2>` +
        `<p class="src">서식 파일입니다. 미리보기는 생략합니다.` +
        (link ? ` <a href="${esc(link)}">원본 내려받기 ↗</a>` : '') +
        `</p></article>`
      );
      continue;
    }
    parts.push(
      `<article id="${esc(id)}">` +
      `<h2>${esc(a.articleId)}${a.title && a.title !== a.articleId ? ` ${esc(a.title)}` : ''}` +
      `<span class="no">#${esc(id)}</span></h2>` +
      (link && a.section === '별표' ? `<p class="src"><a href="${esc(link)}">원본 파일 내려받기 ↗</a></p>` : '') +
      `<div class="body">${bodyHtml(a.section === "본칙" ? stripHeads(a.text) : a.text)}</div>` +
      `</article>`
    );
  }

  // 목차. 한 줄씩 세우면 너무 길고, 다 이어 붙이면 글자 벽이 된다.
  // 장·절로 묶고 여러 단으로 흘려서, 눈이 덩어리 단위로 훑게 한다.
  // 장·절 정보는 74% 만 채워져 있다. 빈 조문은 앞 장을 이어받게 한다.
  // 그러지 않으면 목차가 '(구분없음)' 으로 자꾸 끊겨 오히려 읽기 나빠진다.
  // 장은 breadcrumb 에 안 실려서 chapterTop 으로 따로 받는다. 절 번호는 장마다 1부터
  // 다시 매겨지는 것이 원문 그대로이므로, 절 위에 장을 세워야 어디쯤인지 알 수 있다.
  const tocGroups = [];
  let g = null;
  let lastChap = '';
  let lastTop = '';
  let staleChap = '';
  for (const a of list) {
    if (a.section === '본칙') {
      // 장이 바뀌면 앞 장의 절을 이어받지 않는다. breadcrumb 이 장 경계를 안 지켜서,
      // 새 장 첫 조문까지 앞 장 마지막 절을 그대로 물고 오는 문서가 있다
      // (기간제 근로자 관리규칙 제40조: 제3장 보칙인데 breadcrumb 은 제7절 상벌).
      if (a.chapterTop && a.chapterTop !== lastTop) { lastTop = a.chapterTop; staleChap = lastChap; lastChap = ''; }
      if (a.chapter && a.chapter !== staleChap) { lastChap = a.chapter; staleChap = ''; }
    }
    const top = a.section === '본칙' ? lastTop : '';
    // chapterTop 이 장을 맡으므로, breadcrumb 은 절·관일 때만 머리글로 쓴다.
    // breadcrumb 에는 장이 그대로 들어오기도 하고(중복), 앞 장을 잘못 물고 오기도 한다
    // (보수규정 제30조: 실제는 제4장 성과급인데 breadcrumb 은 제3장 기본급여).
    // 장을 못 뽑은 문서는 예전대로 breadcrumb 을 그대로 쓴다.
    const key =
      a.section === '본칙' ? (hasTop ? (JEOL_RE.test(lastChap) ? lastChap : '') : lastChap) : a.section;
    if (!g || g.key !== key || g.top !== top) { g = { key, top, rows: [] }; tocGroups.push(g); }
    g.rows.push(a);
  }
  let shownTop = '';
  const toc = tocGroups
    .map((grp) => {
      let jang = '';
      if (grp.top && grp.top !== shownTop) {
        shownTop = grp.top;
        jang = `<div class="jang">${esc(grp.top)}</div>`;
      }
      const head = grp.key ? `<b>${esc(grp.key)}</b>` : '';
      const annex = grp.key === '별표';
      const items = grp.rows
        .map((a) => {
          const id = anchorOf(a.articleId);
          const no = esc(shortLabel(a.articleId));
          // 별표·별지는 번호만 보여준다. 제목을 붙이면 개정 이력까지 딸려와 목차가 뒤덮인다.
          const t = annex ? '' : a.title && a.title !== a.articleId ? ` ${esc(a.title)}` : '';
          return `<a href="#${esc(id)}"${annex ? ' class="chip"' : ''}><i>${no}</i>${t}</a>`;
        })
        .join('');
      const short = grp.rows.length <= 12 ? ' short' : '';
      return `${jang}<div class="tg${short}${annex ? ' chips' : ''}">${head}${items}</div>`;
    })
    .join('');

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.name)}</title><style>${VIEW_CSS}</style></head><body>
<header><h1>${esc(d.name)}</h1>
<div class="meta">${esc(d.dateKind ?? '시행')} ${esc(d.effectiveDate ?? '표기 없음')}${d.lawNo ? ` · 제${esc(d.lawNo)}호` : ''} · ${esc(d.source ?? '')} · 조문 ${list.length}건<br>
자료 수집일 ${esc(STATE.idx.dataAsOf)}${d.originalUrl ? ` · <a href="${esc(d.originalUrl)}">원문 내려받기</a>` : ''}</div></header>
${d.status && d.status !== '현행' ? `<p class="warn">이 문서는 <b>${esc(d.status)}</b> 상태입니다. 시행일을 확인하세요.</p>` : ''}
<details class="toc" open><summary>조문 목록 ${list.length}건</summary>${toc}</details>
${parts.join('\n')}
<a class="top" href="#">↑ 맨 위</a>
<script>
(function(){
  var h=document.querySelector('header');
  if(!h)return;
  function set(){document.documentElement.style.setProperty('--hdr',h.offsetHeight+'px');}
  set();
  addEventListener('resize',set);
  // 목차를 접었다 펴면 머리말 높이는 그대로지만, 폰트가 늦게 실리면 달라진다.
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(set);
})();
</script>
</body></html>`;
}

// ── 주기 업무 ──────────────────────────────────────────────
// "분기별로 뭘 해야 하나" 같은 질문은 낱말 검색으로 잘 안 걸린다.
// 조문 본문에 '매분기'는 한 번 스칠 뿐이고, 정작 그 조문의 주제어는 따로 있기 때문이다.
// 사람은 이럴 때 '매분기·반기·연 1회' 를 직접 훑어 찾는다. 그 방식을 그대로 도구로 만든다.
const CYCLE_RE = {
  매월: /매\s*월|월별|매달/,
  매분기: /매\s*분기|분기별|분기마다/,
  매반기: /매\s*반기|반기별|반기마다/,
  매년: /매\s*년|매년도|연간|매\s*회계연도|년\s*1회|연\s*\d+회/,
  수시: /수시로|필요할 때마다|지체\s*없이|즉시/,
  횟수: /\d+\s*회\s*이상|\d+\s*회\s*이하/,
};
const CYCLE_ORDER = ['매월', '매분기', '매반기', '매년', '횟수', '수시'];

// 질문이 주기를 묻고 있는지 본다. '주기적으로 챙길 일' 같은 표현은 조문 낱말과 안 겹쳐서,
// 검색만으로는 매분기 보고 조문을 놓친다.
const CYCLE_INTENT = /주기|정기|분기|반기|매월|매년|월별|연간|상시|챙겨|챙길|해야\s*하는|해야\s*할|확인해야|체크리스트/;

// 조문에서 주기 표현을 찾아 그 앞뒤를 함께 돌려준다. 무엇을 언제 해야 하는지 한눈에 보이도록.
// 발췌는 짧게 자른다. 길면 모델이 그 한 항목을 붙들고 늘어져서,
// 목록 전체를 훑어야 할 질문에 한 조문만 깊게 설명하는 답이 나온다.
function cycleSnippet(text, re) {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  const m = t.match(re);
  if (!m) return null;
  const at = t.indexOf(m[0]);
  const from = Math.max(0, at - 25);
  const to = Math.min(t.length, at + 65);
  return (from ? '…' : '') + t.slice(from, to).trim() + (to < t.length ? '…' : '');
}

function findCycles({ document, cycle, scope }) {
  const S = STATE;
  const wantCycles = cycle && cycle !== '전체' ? [cycle] : CYCLE_ORDER;
  const dq = document ? normText(document) : null;
  const docOk = (docId) => {
    const d = S.docs.get(docId);
    if (!d) return false;
    if (dq && !normText(d.name).includes(dq)) return false;
    if (scope === '내부규정' && !docId.startsWith('내규:')) return false;
    if (scope === '법제처' && !docId.startsWith('법령:')) return false;
    return true;
  };

  const found = new Map();          // 주기 → [{article, snippet}]
  for (const a of S.articles) {
    if (a.section !== '본칙' || !docOk(a.docId)) continue;
    const hay = `${a.title ?? ''} ${a.text ?? ''}`;
    for (const c of wantCycles) {
      const snip = cycleSnippet(hay, CYCLE_RE[c]);
      if (!snip) continue;
      if (!found.has(c)) found.set(c, []);
      found.get(c).push({ a, snip });
      break;                        // 조문 하나는 가장 짧은 주기 한 곳에만 넣는다
    }
  }
  return found;
}

// 검색 결과에 덧붙일 주기 업무 요약. 발췌 없이 한 줄씩만 준다.
// 목록을 넓게 보여주는 것이 목적이라, 여기서 본문을 길게 주면 오히려 한 항목만 파고들게 된다.
function cycleDigest(docIds) {
  const found = findCycles({});
  const want = new Set(docIds ?? []);
  const rows = [];
  for (const c of CYCLE_ORDER) {
    for (const { a } of found.get(c) ?? []) {
      if (want.size && !want.has(a.docId)) continue;
      const d = STATE.docs.get(a.docId);
      rows.push(`  · [${c}] ${d?.name ?? '?'} ${a.articleId}${a.title ? ` (${a.title})` : ''}`);
    }
  }
  if (!rows.length) return '';
  return (
    `\n\n※ 주기가 걸린 질문으로 보여, 위 검색과 별개로 주기 업무를 전수로 훑었습니다. ${rows.length}건입니다.\n` +
    `검색 결과에 안 나온 조문이 섞여 있습니다. 빠뜨리지 말고 전부 나열하십시오.\n` +
    rows.join('\n') +
    `\n\n한 항목만 깊게 설명하지 마십시오. 위 목록을 주기별로 한 줄씩 모두 훑은 뒤,\n` +
    `"어느 항목을 자세히 볼까요?" 라고 되물으십시오. 상세 설명은 그때 합니다.\n` +
    `자세히 답할 때는 find_cycle_duties 나 get_provision 으로 원문을 확인하십시오.`
  );
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
    // 장·절 제목이 질의와 맞으면 밀어준다.
    // '신청 절차' 를 물으면 「제2장 지원 신청」 아래 조문들이 다 같이 올라와야 하는데,
    // 조문 본문에는 '신청' 이 한 번씩만 나와 짧고 무관한 조문에 밀리기 때문이다.
    if (a.chapter) {
      const cn = normText(a.chapter);
      let hit = 0;
      for (const g of qg) if (cn.includes(g)) hit++;
      if (hit) s *= 1 + 2.5 * (hit / qg.length);
    }
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
function clip(t, section) {
  const s = String(t ?? '');
  const cap = capOf(section);
  return s.length > cap ? s.slice(0, cap) + '\n…(이하 생략, 원문 확인 필요)' : s;
}

function renderArticle(a, withText = true) {
  const d = STATE.docs.get(a.docId);
  const head = [
    `■ ${d?.name ?? '(문서명 없음)'} ${a.articleId}`,
    `  출처: ${d?.source ?? '-'}${d?.kind ? ` · ${d.kind}` : ''}`,
    `  구분: ${a.section}${a.section !== '본칙' ? ' (본칙 아님)' : ''}`,
    ...(a.chapter ? [`  위치: ${a.chapter}`] : []),
    // 두 날짜를 조문마다 붙인다. 답변 끝의 '참고 문서' 를 모델이 빠뜨려도
    // 조문 본문 바로 위에 있어 눈에 걸린다.
    `  ${d?.dateKind ?? '시행'}일: ${d?.effectiveDate ?? '표기 없음'}${d?.lawNo ? ` · 제${d.lawNo}호` : ''}` +
      `  |  이 자료 수집일: ${STATE.idx.dataAsOf}`,
    `  상태: ${d?.status ?? '-'}${d?.status && d.status !== '현행' ? ' ※ 아직 시행 전입니다' : ''}`,
  ];
  if (a.needsOriginal) head.push('  ※ 별표·도표가 포함된 조문입니다. 정확한 내용은 원문을 확인하세요.');
  // 브라우저에서 바로 열리는 주소. 원문 링크는 한글 파일을 내려받게 해서 현장에서 쓰기 어렵다.
  if (d?.originalUrl) head.push(`  원문 내려받기: ${d.originalUrl}`);
  if (withText) head.push('', clip(a.text, a.section));
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

const ymd = (v) => String(v ?? '').replace(/-/g, '. ').replace(/$/, '.');

// 답변 끝에 붙일 출처. 두 가지 날짜를 함께 밝힌다.
//  · 문서 개시일 — 그 규정이 언제 자 것인지. 사용자가 최신본과 대조할 수 있다.
//  · 자료 수집일 — 이 서버가 언제 긁어온 것인지. 그 뒤 개정은 반영돼 있지 않다.
// 둘 중 하나만 있으면 "낡은 자료를 최신인 줄 알고 쓰는" 사고를 막지 못한다.
function footer(docIds) {
  const asOf = STATE.idx.dataAsOf;
  const ids = [...new Set((docIds ?? []).filter(Boolean))];
  if (!ids.length) {
    return `\n---\n자료 수집일: ${ymd(asOf)} · 수록 문서 ${STATE.docs.size}건 / 조문 ${STATE.N}건`;
  }

  const rows = [];
  let pending = false;
  for (const id of ids) {
    const d = STATE.docs.get(id);
    if (!d) continue;
    if (d.status && d.status !== '현행') pending = true;
    // 문서명 자체를 마크다운 링크로 준다. 모델이 이 줄을 그대로 옮기면
    // 사용자 화면에서 눌러서 열리는 글자가 된다. 주소만 따로 적어두면 눌리지 않는다.
    const v = viewUrl(id);
    const name = v ? `[${d.name}](${v})` : d.name;
    rows.push(
      `  · ${name} (${d.dateKind ?? '시행'} ${ymd(d.effectiveDate)}` +
      `${d.lawNo ? ` · 제${d.lawNo}호` : ''})` +
      `${d.status && d.status !== '현행' ? ` ※${d.status}` : ''}`
    );
  }
  if (!rows.length) {
    return `\n---\n자료 수집일: ${ymd(asOf)} · 수록 문서 ${STATE.docs.size}건 / 조문 ${STATE.N}건`;
  }

  return (
    `\n\n---\n참고 문서\n` +
    rows.join('\n') +
    `\n\n  (최신자료 확인일: ${ymd(asOf)})\n` +
    `LLM 주의: 답변 끝에 위 '참고 문서' 를 그대로 옮겨 적으십시오. 문서명과 날짜를 빼지 마십시오.\n` +
    `문서명에 걸린 [이름](주소) 형태를 그대로 두어야 사용자가 눌러서 원문을 열 수 있습니다. ` +
    `주소를 따로 떼어 적거나 이름만 남기지 마십시오.\n` +
    `사용자가 개시일을 보고 최신본인지 스스로 확인할 수 있어야 합니다. ` +
    `수집일 이후의 개정은 반영돼 있지 않을 수 있습니다.` +
    (pending ? `\n※ 아직 시행 전인 문서가 섞여 있습니다. 시행일을 확인하고 답하십시오.` : '')
  );
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
      '【주기 업무는 전용 도구를 쓴다】 "분기별로 뭘 해야 하나", "담당자가 주기적으로 챙길 업무", "정기 보고·점검 일정" 처럼 ' +
      '주기가 걸린 질문은 이 도구 대신 find_cycle_duties 를 먼저 쓴다. 매분기·매반기 같은 표현은 조문에 한 번 스칠 뿐이라, ' +
      '낱말 검색으로는 실시상황보고처럼 정작 중요한 조문을 놓친다.\n' +
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
    name: 'find_cycle_duties',
    description:
      '주기가 정해진 업무를 모아서 돌려준다. "분기별로 뭘 해야 하나", "담당자가 주기적으로 챙길 업무", ' +
      '"정기 보고·점검·평가 일정" 같은 질문에는 search_provisions 보다 이 도구를 먼저 쓴다.\n' +
      '조문 본문에서 매월·매분기·매반기·매년·연 N회 같은 표현을 직접 훑어 모으므로, ' +
      '검색어가 조문의 낱말과 달라도 빠뜨리지 않는다. 실시상황보고·지도점검·운영평가처럼 ' +
      '조문 제목만 봐서는 주기를 알 수 없는 업무를 찾는 데 특히 쓸모가 있다.\n' +
      'document 로 규정을 좁힐 수 있고, 비우면 전체에서 찾는다. ' +
      '규정과 규칙에 나뉘어 있으므로 한쪽만 보고 끝내지 말 것.\n' +
      '주기 표현이 없는 의무는 잡히지 않으니, 빠진 것이 있는지 get_provision 의 목차나 전문으로 보완한다.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: '이 규정 안에서만 찾는다. 문서명 일부면 된다. 예: 장애인 직업능력개발훈련 지원규정' },
        cycle: { type: 'string', enum: ['전체', '매월', '매분기', '매반기', '매년', '횟수', '수시'], description: '특정 주기만 볼 때. 기본은 전체' },
        scope: { type: 'string', enum: ['전체', '내부규정', '법제처'], description: '검색 범위. 기본값 전체' },
      },
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
        footer(hits.map((a) => a.docId))
      );
    }

    // 조문을 콕 집어 물었으면 문서를 고를 것도 없다. 예전 경로 그대로.
    if (/제\s*\d+\s*조/.test(q)) {
      const hits = search(q, { scope, section: args.section, limit });
      if (hits.length) {
        return (
          `검색어: ${q} · ${hits.length}건\n\n` +
          hits.map((a) => renderArticle(a)).join('\n\n') +
          footer(hits.map((a) => a.docId))
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
        footer(w.map((a) => a.docId))
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
        footer([a.top.docId, a.second.docId])
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
    // 주기가 걸린 질문이면 전용 도구 결과를 여기서 바로 붙인다.
    // 모델이 도구를 골라 쓰기를 기다리면 놓친다. 실제로 실시상황보고를 그렇게 놓쳤다.
    // 요약 범위는 1등 문서와 그 형제로 좁힌다.
    // 성격별 1등을 전부 넣으면 행동강령 같은 무관한 규정까지 딸려와 목록이 흐려진다.
    const lead = picked[0];
    const leadFam = lead ? familyKey(lead.name) : null;
    const cycleDocs = picked
      .filter((r) => !leadFam || familyKey(r.name) === leadFam || r === lead)
      .map((r) => r.docId);
    const cycleAdd = CYCLE_INTENT.test(q) ? cycleDigest(cycleDocs) : '';
    return (
      head +
      hits.map((a) => renderArticle(a)).join('\n\n') +
      cycleAdd +
      (pinpoint ? '' : siblingNotice(hits.map((a) => a.docId))) +
      footer(hits.map((a) => a.docId))
    );
  }

  if (name === 'get_provision') {
    const dq = normText(args.document);
    const cands = [...STATE.docs.values()].filter((d) => normText(d.name).includes(dq));
    if (!cands.length) return NOT_FOUND(`"${args.document}" 이라는 규정을 찾지 못했습니다.`, 'list_documents 로 이름을 확인하십시오.');

    const sorted = [...cands].sort((a, b) => a.name.length - b.name.length);
    const want = String(args.article ?? '').replace(/[\s[\]]/g, '');
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
          if (!rows.length) return null;
          // 장·절이 붙어 있으면 그 단위로 묶어 보여준다. 어디까지가 한 덩어리인지 눈에 보이게.
          const out = [`[${sec}] ${rows.length}건`];
          let cur = null;
          for (const x of rows) {
            const ch = x.chapter ?? null;
            if (ch !== cur) { if (ch) out.push(` ${ch}`); cur = ch; }
            out.push(line(x));
          }
          return out.join('\n');
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
        footer([d.docId])
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
        const size = Math.min(String(a.text ?? '').length, capOf(a.section)) + 60;
        if (cur.length && used + size > MAX_FULL_CHARS) { pages.push(cur); cur = []; used = 0; }
        cur.push(a);
        used += size;
      }
      if (cur.length) pages.push(cur);

      const p = Math.min(Math.max(Number((want.match(/\d+/) ?? ['1'])[0]) || 1, 1), pages.length);
      const rows = pages[p - 1];
      const clipped = rows.filter((a) => String(a.text ?? '').length > capOf(a.section)).length;
      const body = rows
        .map((a) => `■ ${a.articleId}${a.title ? ` (${a.title})` : ''}${a.section !== '본칙' ? ` [${a.section}]` : ''}\n` + clip(a.text, a.section))
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
        footer([d.docId])
      );
    }

    // 조문 하나를 콕 집어 물은 경우: 군더더기 없이 그 조문만 돌려준다
    // 별표는 실제로 '[별표 2] (제14조 관련) <개정 …>' 처럼 저장돼 있다.
    // 사람도 모델도 '별표 2' 라고 치므로, 대괄호와 공백을 지우고 견준다.
    const key = (x) => String(x ?? '').replace(/[\s[\]]/g, '');
    for (const d of cands) {
      const a = STATE.articles.find((x) => x.docId === d.docId && key(x.articleId) === want);
      if (a) return renderArticle(a) + footer([a.docId]);
    }
    // 별표는 조문번호 뒤에 '(제29조 관련)', '<개정 …>' 이 붙어 있어 정확히 맞히기 어렵다.
    // 사람이 쓰는 '[별표 3]' 으로도 열리도록 앞부분만 맞아도 받아준다.
    for (const d of cands) {
      const hit = STATE.articles.filter((x) => x.docId === d.docId && key(x.articleId).startsWith(want));
      if (hit.length === 1) return renderArticle(hit[0]) + footer([hit[0].docId]);
      if (hit.length > 1) {
        return (
          `■ ${d.name} · "${args.article}" 로 시작하는 조문이 ${hit.length}건입니다.\n` +
          `아래에서 골라 article 에 정확히 넣어 다시 부르십시오.\n\n` +
          hit.map((x) => `  ${x.articleId}${x.title ? ` (${x.title})` : ''}`).join('\n') +
          footer([d.docId])
        );
      }
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

  if (name === 'find_cycle_duties') {
    const found = findCycles({ document: args.document, cycle: args.cycle, scope: args.scope });
    const total = [...found.values()].reduce((n, v) => n + v.length, 0);
    if (!total) {
      return NOT_FOUND(
        `${args.document ? `"${args.document}" 에서 ` : ''}주기가 정해진 업무를 찾지 못했습니다.`,
        'document 를 빼고 다시 부르거나, list_documents 로 규정 이름을 확인해 보십시오.'
      );
    }

    const label = { 매월: '매월', 매분기: '매분기', 매반기: '매반기', 매년: '매년·연간', 횟수: '연 N회 이상', 수시: '수시·즉시' };
    const parts = [];
    const counts = [];
    for (const c of CYCLE_ORDER) {
      const rows = found.get(c);
      if (!rows) continue;
      parts.push(
        `【${label[c]}】 ${rows.length}건\n` +
        rows
          .map(({ a, snip }) => {
            const d = STATE.docs.get(a.docId);
            return `  · ${d?.name ?? '?'} ${a.articleId}${a.title ? ` (${a.title})` : ''}\n      ${snip}`;
          })
          .join('\n')
      );
      counts.push(`${label[c]} ${rows.length}`);
    }

    return (
      `주기가 정해진 업무 ${total}건` +
      (args.document ? ` · ${args.document} 안` : '') +
      (args.cycle && args.cycle !== '전체' ? ` · ${args.cycle}` : '') + '\n' +
      `내역: ${counts.join(' / ')}\n\n` +
      `【답변 방식 — 반드시 지킬 것】\n` +
      `이것은 목록형 질문입니다. 아래 ${total}건을 하나도 빠뜨리지 말고 주기별로 한 줄씩 나열하십시오.\n` +
      `한 줄은 "무엇을 · 언제까지 · 근거조문" 이면 충분합니다. 조문 하나를 골라 깊게 풀어쓰지 마십시오.\n` +
      `점검·보고 중 어느 하나만 자세히 설명하고 나머지를 생략하는 것이 가장 흔한 실수입니다.\n` +
      `나열을 마친 뒤 "어느 항목을 자세히 볼까요?" 라고 되물으십시오. 상세 설명은 그때 합니다.\n` +
      `아래 발췌는 나열용 요약일 뿐입니다. 자세히 답할 때는 get_provision 으로 전문을 확인하십시오.\n` +
      `주기 표현이 없는 의무(신청이 올 때마다 처리하는 일 등)는 여기 안 잡히니, ` +
      `빠진 것이 있는지 get_provision 의 목차로 보완하십시오.\n\n` +
      parts.join('\n\n') +
      footer([...new Set([...found.values()].flat().map(({ a }) => a.docId))])
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
  if (!process.env.PUBLIC_URL && req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] ?? (req.headers.host.startsWith('localhost') ? 'http' : 'https');
    PUBLIC_BASE = `${proto}://${req.headers.host}`;
  }

  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    const body = STATE
      ? { ok: true, docs: STATE.docs.size, articles: STATE.N, dataAsOf: STATE.idx.dataAsOf, loadedAt: STATE.loadedAt }
      : { ok: false, note: '인덱스 적재 전' };
    if (STATE) {
      body.keyRequired = KEYS.size > 0;
      body.source = STATE.source;          // '원격' 또는 '로컬 캐시'
    }
    // 인덱스 적재 전에는 503 을 준다. 200 을 주면 프록시가 준비된 줄 알고
    // 배포 도중 요청을 흘려보내, 첫 질문이 몇 초 멎는다.
    return res
      .writeHead(STATE ? 200 : 503, { ...CORS, 'Content-Type': 'application/json' })
      .end(JSON.stringify(body));
  }

  // 원문 뷰어: /doc/<규정이름>#제25조  또는  /d/<짧은키>#별표2
  if (req.method === 'GET' && (url.pathname.startsWith('/doc/') || url.pathname.startsWith('/d/'))) {
    try {
      await ensureIndex();
    } catch {
      return res.writeHead(503, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' }).end('자료를 준비하지 못했습니다.');
    }
    const short = url.pathname.startsWith('/d/');
    const raw = decodeURIComponent(url.pathname.slice(short ? 3 : 5));
    let cands;
    if (short) {
      slugOf([...STATE.docs.keys()][0]);                 // 키 표를 만들어 둔다
      const id = STATE.byslug.get(raw);
      cands = id && STATE.docs.has(id) ? [STATE.docs.get(id)] : [];
    } else {
      const q = normText(raw);
      cands = [...STATE.docs.values()].filter((d) => normText(d.name).includes(q));
    }
    const html = (b) => res.writeHead(b.code, { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' }).end(b.body);

    if (!cands.length) {
      const all = [...STATE.docs.values()]
        .map((d) => `<li><a href="/doc/${encodeURIComponent(d.name)}">${esc(d.name)}</a></li>`)
        .join('');
      return html({
        code: 404,
        body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<style>${VIEW_CSS}</style><h1>그런 규정이 없습니다</h1><p class="meta">수록된 규정 ${STATE.docs.size}건</p><ul>${all}</ul>`,
      });
    }
    const d = cands.sort((a, b) => a.name.length - b.name.length)[0];
    const list = STATE.articles.filter((x) => x.docId === d.docId);
    return html({ code: 200, body: renderDocHtml(d, list) });
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
