// 법제처 국가법령정보 OPEN API 수집기
// 현행 법령·행정규칙을 조문 단위로 받아 data/laws.json 에 저장한다.
// 실행: node fetch-law.js   (OC 값은 환경변수 LAW_OC 로 넘긴다)

import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const OC = process.env.LAW_OC;
if (!OC) {
  console.error('환경변수 LAW_OC 가 없습니다. 법제처에서 발급받은 OC 값을 넣어주세요.');
  process.exit(1);
}

const BASE = 'https://www.law.go.kr/DRF';
const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function findLatest(name, target) {
  for (const q of queryVariants(name)) {
    const hit = await searchOnce(q, name, target);
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

async function searchOnce(query, name, target) {
  const url = `${BASE}/lawSearch.do?OC=${encodeURIComponent(OC)}&target=${target}&type=XML&display=100&query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`목록조회 HTTP ${res.status}`);
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
async function fetchArticles(mst, target) {
  const url = `${BASE}/lawService.do?OC=${encodeURIComponent(OC)}&target=${target}&MST=${mst}&type=XML`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`본문조회 HTTP ${res.status}`);
  const doc = parser.parse(await res.text());

  const root = doc['법령'] ?? doc['행정규칙'] ?? Object.values(doc)[0];
  const unit = root?.['조문']?.['조문단위'] ?? root?.['조문내용'];
  const rows = asArray(unit);

  const out = [];
  for (const a of rows) {
    if (typeof a === 'string') {           // 행정규칙은 조문이 통짜 텍스트인 경우가 있다
      out.push({ articleNo: null, title: null, text: a });
      continue;
    }
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
  return out;
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
      docs.push({
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
        articles,
      });
      console.log(`OK  ${meta.title} (${meta.kind}) 시행 ${meta.effective} · 조문 ${articles.length}`);
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
        totalArticles: docs.reduce((s, d) => s + d.articleCount, 0),
        failed,
      },
      null,
      2
    )
  );
  console.log(`\n요청 ${targets.length} / 수집 ${docs.length} / 실패 ${failed.length}`);
}

main();
