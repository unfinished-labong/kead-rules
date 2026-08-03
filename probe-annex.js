// 별표 수집 진단기.
//
// 법제처 응답에 별표가 어떤 태그로 들어오는지 확인한다.
// fetch-law.js 를 고치기 전에 태그 이름이 맞는지 보려고 만들었다.
//
//   LAW_OC=xxx node probe-annex.js
//   LAW_OC=xxx node probe-annex.js "장애인 직업능력개발훈련 지원규정"
//
// 출력에는 OC 값이 절대 들어가지 않는다. 로그를 그대로 복사해도 안전하다.

import { XMLParser } from 'fast-xml-parser';
import { readFile } from 'node:fs/promises';

const OC = process.env.LAW_OC;
if (!OC) {
  console.error('환경변수 LAW_OC 가 없습니다.');
  process.exit(1);
}
const BASE = 'https://www.law.go.kr/DRF';
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hide = (s) => String(s).split(encodeURIComponent(OC)).join('***').split(OC).join('***');

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kead-rules/0.3)', Accept: 'application/xml,text/xml,*/*' },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return await res.text();
    } catch {}
    await sleep(800);
  }
  return null;
}

async function findLatest(name, target) {
  const url = `${BASE}/lawSearch.do?OC=${encodeURIComponent(OC)}&target=${target}&type=XML&display=100&query=${encodeURIComponent(name)}`;
  const xml = await get(url);
  if (!xml) return null;
  const root = parser.parse(xml)?.LawSearch ?? parser.parse(xml)?.[Object.keys(parser.parse(xml))[0]];
  const rows = asArray(root?.law ?? root?.admrul ?? root?.AdmRul);
  const cands = rows
    .map((r) => ({
      mst: r['법령일련번호'] ?? r['행정규칙일련번호'],
      title: r['법령명한글'] ?? r['행정규칙명'],
      status: r['현행연혁코드'] ?? r['현행연혁구분'],
    }))
    .filter((r) => r.mst && r.title);
  const exact = cands.filter((r) => String(r.title).replace(/\s/g, '') === name.replace(/\s/g, ''));
  return (exact[0] ?? cands[0]) ?? null;
}

// 태그 뼈대만 뽑는다. 값은 길이만 적어서 원문이 새지 않게 한다.
function skeleton(node, depth = 0, out = [], path = '') {
  if (depth > 4 || !node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path} > ${k}` : k;
    if (Array.isArray(v)) {
      out.push(`${'  '.repeat(depth)}${k} [배열 ${v.length}]`);
      if (v[0] && typeof v[0] === 'object') skeleton(v[0], depth + 1, out, p);
    } else if (v && typeof v === 'object') {
      out.push(`${'  '.repeat(depth)}${k} {}`);
      skeleton(v, depth + 1, out, p);
    } else {
      const s = String(v ?? '');
      out.push(`${'  '.repeat(depth)}${k} = ${s.length > 40 ? `(${s.length}자)` : s}`);
    }
  }
  return out;
}

const TARGETS = process.argv[2]
  ? [{ name: process.argv[2], target: /법$|법률$|시행령$|시행규칙$/.test(process.argv[2]) ? 'law' : 'admrul' }]
  : null;

async function main() {
  let list = TARGETS;
  if (!list) {
    const all = JSON.parse(await readFile('targets.json', 'utf-8'));
    // 별표가 있을 법한 것 위주로 몇 건만
    const pick = (re) => all.find((t) => re.test(t.name));
    list = [
      pick(/직업능력개발훈련 지원규정/),
      pick(/^장애인고용촉진 및 직업재활법$/),
      pick(/^장애인고용촉진 및 직업재활법 시행령$/),
      pick(/부담기초액/),
    ].filter(Boolean);
  }

  for (const t of list) {
    console.log(`\n${'='.repeat(64)}\n■ ${t.name}  (target=${t.target})`);
    const meta = await findLatest(t.name, t.target);
    if (!meta) {
      console.log('  목록 조회 실패 — 이름이 안 맞거나 접속 문제');
      continue;
    }
    console.log(`  일련번호 ${meta.mst} · ${meta.status ?? ''}`);

    const params = t.target === 'law' ? ['MST', 'ID'] : ['ID', 'MST', 'LID'];
    let xml = null;
    let used = null;
    for (const p of params) {
      const got = await get(`${BASE}/lawService.do?OC=${encodeURIComponent(OC)}&target=${t.target}&${p}=${meta.mst}&type=XML`);
      if (got && got.length > 300) {
        xml = got;
        used = p;
        break;
      }
      await sleep(300);
    }
    if (!xml) {
      console.log('  본문 조회 실패');
      continue;
    }
    console.log(`  본문 ${xml.length}바이트 · 파라미터 ${used}`);

    // 1) 원문에 '별표' 라는 글자가 태그로 등장하는가
    const tags = [...new Set([...xml.matchAll(/<([^\s/>?!][^\s>]*)/g)].map((m) => m[1]))];
    const annexTags = tags.filter((x) => x.includes('별표') || x.includes('서식'));
    console.log(`  전체 태그 ${tags.length}종 · 별표/서식 관련: ${annexTags.length ? annexTags.join(', ') : '(없음)'}`);

    // 2) 파싱한 구조에서 별표 마디 찾기
    const doc = parser.parse(xml);
    const root = doc['법령'] ?? doc['행정규칙'] ?? Object.values(doc)[0];
    console.log(`  최상위 자식: ${Object.keys(root ?? {}).join(', ')}`);

    const holder = Object.entries(root ?? {}).find(([k]) => k.includes('별표'));
    if (!holder) {
      console.log('  → 응답에 별표 마디가 없습니다.');
      continue;
    }
    console.log(`\n  ── "${holder[0]}" 안쪽 뼈대 (값은 길이만) ──`);
    for (const line of skeleton(holder[1], 1).slice(0, 40)) console.log('  ' + line);
  }
  console.log('\n끝. 위 출력을 그대로 복사해서 전달하면 됩니다. OC 값은 포함되지 않습니다.');
}

main().catch((e) => {
  console.error('오류:', hide(e.message));
  process.exit(1);
});
