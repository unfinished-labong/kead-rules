// 법제처 국가법령정보 OPEN API 수집기
// 현행 법령·행정규칙을 조문 단위로 받아 data/laws.json 에 저장한다.
// 실행: node fetch-law.js   (OC 값은 환경변수 LAW_OC 로 넘긴다)

import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';

import path from 'node:path';
import { convertFile } from './fetch-docs.js';

const ANNEX_TMP = '.tmp-annex';
const OC = process.env.LAW_OC;
if (!OC) {
  console.error('환경변수 LAW_OC 가 없습니다. 법제처에서 발급받은 OC 값을 넣어주세요.');
  process.exit(1);
}

const BASE = 'https://www.law.go.kr/DRF';
const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// XML 선언(<?xml …?>)도 마디로 파싱돼 들어온다.
// Object.values(doc)[0] 로 뿌리를 집으면 그 선언을 잡아버려 그 아래를 못 훑는다.
// 행정규칙(고시)은 최상위 태그 이름이 '행정규칙' 이 아니라서 이 함수가 없으면 통째로 놓친다.
function docRoot(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const named = doc['법령'] ?? doc['행정규칙'];
  if (named) return named;
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('?') || k.startsWith('@_')) continue;   // 선언·속성은 건너뛴다
    if (v && typeof v === 'object') return v;
  }
  return doc;
}

// 법제처 서버가 간헐적으로 연결을 끊는다. 재시도하고, 실패하면 원인 코드를 남긴다.
// 'fetch failed' 만으로는 장애인지 차단인지 구분할 수 없어서다.
export async function fetchRetry(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          // 법제처 API가 Node 기본 UA(undici/...)를 봇으로 보고 거부한다.
          // 일반 브라우저 UA를 보내야 통과한다.
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/xml,text/xml,*/*',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
    // https가 막히면 http로도 한 번 시도한다
    if (i === tries - 2 && url.startsWith('https://')) url = 'http://' + url.slice(8);
    await sleep(1000 * (i + 1) ** 2);
  }
  const code = last?.cause?.code ?? last?.code ?? last?.name ?? '';
  throw new Error(`${last?.message ?? '연결 실패'}${code ? ` [${code}]` : ''}`);
}

function ymd(v) {
  const s = String(v ?? '').replace(/\D/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// 가운뎃점은 문서마다 표기가 달라(· ㆍ ‧ ∙ ・) 검색이 어긋난다. 비교할 땐 전부 지운다.
const DOTS = /[·ㆍ‧∙・]/g;
const HAS_DOT = /[·ㆍ‧∙・]/;   // /g 로 test()를 반복하면 lastIndex가 밀려 결과가 번갈아 나온다
const norm = (x) => String(x ?? '').replace(DOTS, '').replace(/\s+/g, '');

// 같은 이름의 가운뎃점 변형들을 만들어 차례로 시도한다.
function queryVariants(name) {
  const set = new Set([name]);
  if (HAS_DOT.test(name)) {
    set.add(name.replace(DOTS, 'ㆍ'));
    set.add(name.replace(DOTS, '·'));
    set.add(name.replace(DOTS, ''));
    set.add(name.replace(DOTS, ' '));
  }
  return [...set];
}

// ── 목록 조회: 이름으로 현행본을 찾아 법령일련번호(MST)를 얻는다 ──
export async function findLatest(name, target) {
  for (const q of queryVariants(name)) {
    const hit = await searchOnce(q, name, target);
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

async function searchOnce(query, name, target) {
  const url = `${BASE}/lawSearch.do?OC=${encodeURIComponent(OC)}&target=${target}&type=XML&display=100&query=${encodeURIComponent(query)}`;
  const res = await fetchRetry(url);
  const doc = parser.parse(await res.text());

  const root = doc.LawSearch ?? doc.AdmRulSearch ?? Object.values(doc)[0];
  const rows = asArray(root?.law ?? root?.admrul ?? root?.AdmRul);

  // 이름이 정확히 일치하는 것 우선, 없으면 포함하는 것
  const wanted = norm(name);

  const candidates = rows
    .map((r) => ({
      mst: r['법령일련번호'] ?? r['행정규칙일련번호'],
      title: r['법령명한글'] ?? r['행정규칙명'],
      kind: r['법령구분명'] ?? r['행정규칙종류'],
      status: r['현행연혁코드'] ?? r['현행연혁구분'],
      promulgated: ymd(r['공포일자'] ?? r['발령일자']),
      effective: ymd(r['시행일자']),
      no: r['공포번호'] ?? r['발령번호'],
    }))
    .filter((r) => r.mst && r.title);

  const exact = candidates.filter((r) => norm(r.title) === wanted);
  const pool = exact.length ? exact : candidates.filter((r) => norm(r.title).includes(wanted));
  if (!pool.length) return null;

  // 현행 우선, 그다음 시행일 최신
  pool.sort((a, b) => {
    const cur = (x) => (x.status === '현행' ? 1 : 0);
    if (cur(b) !== cur(a)) return cur(b) - cur(a);
    return String(b.effective ?? '').localeCompare(String(a.effective ?? ''));
  });
  return pool[0];
}

// ── 본문 조회: 조문 단위로 쪼갠다 ──
// 법령은 MST(법령일련번호), 행정규칙은 ID(행정규칙일련번호)를 쓴다.
// 확실치 않으므로 후보를 차례로 시도하고 통한 것을 기록한다.
const ID_PARAMS = { law: ['MST', 'ID'], admrul: ['ID', 'MST', 'LID'] };

export async function fetchArticles(serial, target) {
  const tried = [];
  for (const p of ID_PARAMS[target] ?? ['MST', 'ID']) {
    const url = `${BASE}/lawService.do?OC=${encodeURIComponent(OC)}&target=${target}&${p}=${serial}&type=XML`;
    const res = await fetchRetry(url);
    const xml = await res.text();
    tried.push({ param: p, bytes: xml.length });

    if (xml.length < 300) continue;                    // 빈 응답이나 오류 안내
    const out = parseBody(xml);
    if (out.length) {
      out.paramUsed = p;
      out.tried = tried;
      out.annexes = parseAnnexes(xml);                 // 같은 응답에 들어 있는 별표
      return out;
    }
    await sleep(250);
  }
  const empty = [];
  empty.tried = tried;
  return empty;
}

export function parseBody(xml) {
  const doc = parser.parse(xml);
  const root = docRoot(doc);
  const unit =
    root?.['조문']?.['조문단위'] ??
    root?.['조문내용'] ??
    root?.['조문']?.['조'] ??
    root?.['조문'];
  const rows = asArray(unit);

  const out = [];
  for (const a of rows) {
    if (typeof a === 'string') {
      out.push({ articleNo: null, title: null, text: a });
      continue;
    }
    if (!a || typeof a !== 'object') continue;
    const body = [a['조문내용'], ...asArray(a['항']).map((h) => h?.['항내용'] ?? h)]
      .filter((x) => typeof x === 'string')
      .join('\n');
    if (!body.trim()) continue;
    out.push({
      articleNo: a['조문번호'] ?? null,
      title: a['조문제목'] ?? null,
      effective: ymd(a['조문시행일자']),
      text: body.trim(),
    });
  }

  // 구조를 모르면 태그만 걷어내고 통짜 텍스트로 넘긴다. 조문 분할은 build-index가 한다.
  if (out.length === 0) {
    const text = xml
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .split('\n').map((s) => s.trim()).filter(Boolean).join('\n');
    if (text.length > 100) out.push({ articleNo: null, title: null, text, fallback: true });
  }
  return out;
}

// ── 별표·서식 ─────────────────────────────────────────────
// 법제처 본문조회 응답에는 <별표단위> 가 함께 들어 있는데 지금까지 읽지 않고 버렸다.
// 그래서 법제처 문서 44건의 별표가 전부 비어 있었다(내부규정은 733건 수록).
// 태그 이름이 대상(법령/행정규칙)마다 조금씩 달라, 이름에 '별표'가 든 마디를 폭넓게 훑는다.
// 담는 그릇 이름(별표, 별표목록, 별표단위…)은 대상마다 달라서 믿을 수 없다.
// 대신 '별표번호·별표제목·별표서식파일링크' 같은 알맹이를 가진 마디를 찾는다.
const ANNEX_FIELD = /^별표(번호|제목|구분|내용|가지번호|서식(번호|명|내용)?|서식?(PDF)?파일링크|파일링크|PDF파일링크)$/;
function findAnnexNodes(root) {
  const out = [];
  const seen = new Set();
  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
    seen.add(node);
    if (!Array.isArray(node) && Object.keys(node).some((k) => ANNEX_FIELD.test(k))) {
      out.push(node);
      return;                                   // 알맹이를 찾았으면 더 파고들지 않는다
    }
    for (const v of Object.values(node)) {
      if (!v || typeof v !== 'object') continue;
      for (const it of asArray(v)) walk(it, depth + 1);
    }
  })(root, 0);
  return out;
}

// 값이 어디 붙어 있는지 확실치 않아 이름으로 찾는다.
function pick(obj, ...names) {
  for (const n of names) {
    for (const [k, v] of Object.entries(obj)) {
      if (k !== n) continue;
      const t = typeof v === 'object' ? (v?.['#text'] ?? v?.['@_href'] ?? '') : v;
      if (t != null && String(t).trim()) return String(t).trim();
    }
  }
  return null;
}

export function parseAnnexes(xml) {
  const doc = parser.parse(xml);
  // 별표는 뿌리를 잘못 짚으면 통째로 사라진다. 문서 전체를 훑는 편이 안전하다.
  const rows = findAnnexNodes(docRoot(doc)).concat(findAnnexNodes(doc));
  const out = [];
  const seenRow = new Set();
  for (const r of rows) {
    if (seenRow.has(r)) continue;
    seenRow.add(r);
    const no = pick(r, '별표번호', '별표서식번호');
    const branch = pick(r, '별표가지번호');
    const kind = pick(r, '별표구분') ?? '별표';
    const title = pick(r, '별표제목', '별표서식명');
    const text = pick(r, '별표내용', '별표서식내용');
    const hwp = pick(r, '별표서식파일링크', '별표파일링크');
    const pdf = pick(r, '별표서식PDF파일링크', '별표PDF파일링크');
    if (!no && !title && !hwp && !pdf) continue;
    const abs = (u) => (u ? (u.startsWith('http') ? u : `https://www.law.go.kr${u.startsWith('/') ? '' : '/'}${u}`) : null);
    out.push({
      no: no ?? null,
      branch: branch && branch !== '0' ? branch : null,
      kind,
      title: title ?? null,
      text: text ?? null,
      fileUrl: abs(hwp),
      pdfUrl: abs(pdf),
    });
  }
  return out;
}

// 별표 본문이 응답에 없으면 첨부파일을 받아 kordoc 으로 읽는다.
// PDF 를 먼저 쓴다. 한글 파일보다 변환이 안정적이다.
async function annexText(a, tag) {
  for (const [url, ext] of [[a.pdfUrl, 'pdf'], [a.fileUrl, 'hwp']]) {
    if (!url) continue;
    try {
      const res = await fetchRetry(url, 2);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) continue;
      await mkdir(ANNEX_TMP, { recursive: true });
      const f = path.join(ANNEX_TMP, `${tag}.${ext}`);
      await writeFile(f, buf);
      const chunks = await convertFile(f);
      const txt = chunks
        .map((c) => (typeof c === 'string' ? c : (c.text ?? c.content ?? '')))
        .filter(Boolean)
        .join('\n')
        .trim();
      await rm(f, { force: true });
      if (txt.length >= 30) return txt.slice(0, 12000);
    } catch (e) {
      // 한 경로가 막히면 다음 경로로 넘어간다
    }
  }
  return null;
}

async function main() {
  const targets = JSON.parse(await readFile('targets.json', 'utf-8'));
  const docs = [];
  const failed = [];

  for (const t of targets) {
    try {
      const meta = await findLatest(t.name, t.target);
      if (!meta) {
        failed.push({ ...t, reason: '검색 결과 없음' });
        continue;
      }
      const articles = await fetchArticles(meta.mst, t.target);

      // 별표: 응답에 본문이 있으면 그대로 쓰고, 없으면 첨부파일을 받아 읽는다.
      const annexes = [];
      for (const [i, a] of (articles.annexes ?? []).entries()) {
        let text = a.text;
        if (!text || text.length < 30) {
          text = await annexText(a, `${meta.mst}-${i}`);
          await sleep(200);
        }
        if (!text && !a.title) continue;
        annexes.push({ ...a, text: text ?? null });
      }
      const annexOk = annexes.filter((a) => a.text).length;

      docs.push({
        annexes,
        source: '법제처',
        target: t.target,
        docName: meta.title,
        kind: meta.kind,
        status: meta.status,
        lawNo: meta.no,
        promulgatedDate: meta.promulgated,
        effectiveDate: meta.effective,
        mst: meta.mst,
        // OC가 노출되지 않는 공개 한글주소를 쓴다
        link:
          t.target === 'law'
            ? `https://www.law.go.kr/법령/${encodeURIComponent(meta.title)}`
            : `https://www.law.go.kr/행정규칙/${encodeURIComponent(meta.title)}`,
        articleCount: articles.length,
        parsedAsBlob: !!articles[0]?.fallback,
        paramUsed: articles.paramUsed ?? null,
        tried: articles.tried ?? null,
        articles,
      });
      console.log(
        `OK  ${meta.title} (${meta.kind}) 시행 ${meta.effective} · 조문 ${articles.length}` +
          (annexes.length ? ` · 별표 ${annexes.length}건(본문 ${annexOk})` : '')
      );
      await sleep(400);
    } catch (e) {
      failed.push({ ...t, reason: e.message });
      console.error(`FAIL ${t.name}: ${e.message}`);
    }
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/laws.json', JSON.stringify(docs, null, 2));
  await writeFile(
    'data/laws-manifest.json',
    JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        requested: targets.length,
        collected: docs.length,
        parsedAsBlob: docs.filter((d) => d.parsedAsBlob).map((d) => d.docName),
        paramUsed: docs.reduce((acc, d) => ((acc[d.paramUsed ?? '실패'] = (acc[d.paramUsed ?? '실패'] || 0) + 1), acc), {}),
        emptyBody: docs.filter((d) => d.articleCount === 0).map((d) => ({ name: d.docName, tried: d.tried })),
        totalArticles: docs.reduce((s, d) => s + d.articleCount, 0),
        failed,
      },
      null,
      2
    )
  );
  const anx = docs.reduce((n, d) => n + (d.annexes?.length ?? 0), 0);
  const anxOk = docs.reduce((n, d) => n + (d.annexes ?? []).filter((a) => a.text).length, 0);
  console.log(`\n요청 ${targets.length} / 수집 ${docs.length} / 실패 ${failed.length}`);
  console.log(`별표 ${anx}건 · 본문 확보 ${anxOk}건 · 제목만 ${anx - anxOk}건`);
  if (anx === 0) {
    console.log('별표가 하나도 안 잡혔습니다. 응답 태그 이름이 예상과 다를 수 있으니 parseAnnexes 를 확인하십시오.');
  }
  if (docs.length === 0 && failed.length > 0) {
    const reasons = [...new Set(failed.map((f) => f.reason))];
    console.error('\n전건 실패입니다. 원인 종류:', reasons.join(' / '));
    console.error('네트워크 오류라면 법제처 접속 장애 또는 차단, HTTP 4xx면 OC 값 문제입니다.');
    process.exitCode = 1;   // 조용히 넘어가지 않도록 단계를 실패로 표시
  }
}

// 진단기(probe-annex.js)가 이 파일을 불러다 쓰므로, 직접 실행할 때만 돈다.
if (import.meta.url === `file://${process.argv[1]}`) main();
