// 별표 수집 진단기.
//
// 법제처 응답에 별표가 어떤 태그로 들어오는지 확인한다.
// fetch-law.js 의 함수를 그대로 불러 쓴다. 여기서 다시 구현하면
// 진단기 자체의 버그와 API 문제를 구별할 수 없다.
//
//   LAW_OC=xxx node probe-annex.js                 (고시 3건 + 시행령 1건)
//   LAW_OC=xxx node probe-annex.js "규정 이름"
//
// 출력에 OC 값과 별표 본문은 들어가지 않는다. 로그를 그대로 복사해도 안전하다.

import { XMLParser } from 'fast-xml-parser';
import { fetchRetry, findLatest, parseAnnexes } from './fetch-law.js';

const OC = process.env.LAW_OC;
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

// 태그 뼈대만. 값은 40자를 넘으면 길이로 대체해 원문이 새지 않게 한다.
function skeleton(node, depth = 0, out = []) {
  if (depth > 4 || !node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    const pad = '  '.repeat(depth);
    if (Array.isArray(v)) {
      out.push(`${pad}${k} [배열 ${v.length}]`);
      if (v[0] && typeof v[0] === 'object') skeleton(v[0], depth + 1, out);
    } else if (v && typeof v === 'object') {
      out.push(`${pad}${k} {}`);
      skeleton(v, depth + 1, out);
    } else {
      const s = String(v ?? '');
      out.push(`${pad}${k} = ${s.length > 40 ? `(${s.length}자)` : s}`);
    }
  }
  return out;
}

const DEFAULTS = [
  { name: '장애인 직업능력개발훈련 지원규정', target: 'admrul' },
  { name: '장애인 취업지원 업무처리 규정', target: 'admrul' },
  { name: '사업주 및 장애인 등에 대한 융자ㆍ지원규정', target: 'admrul' },
  { name: '장애인고용촉진 및 직업재활법 시행령', target: 'law' },   // 잘 되는 것과 대조용
];

async function main() {
  if (!OC) {
    console.error('환경변수 LAW_OC 가 없습니다.');
    process.exit(1);
  }
  const arg = process.argv[2]?.trim();
  const list = arg
    ? [{ name: arg, target: /(법|법률|시행령|시행규칙)$/.test(arg) ? 'law' : 'admrul' }]
    : DEFAULTS;

  for (const t of list) {
    console.log(`\n${'='.repeat(66)}\n■ ${t.name}  (target=${t.target})`);

    let meta;
    try {
      meta = await findLatest(t.name, t.target);
    } catch (e) {
      console.log(`  목록 조회 오류: ${e.message}`);
      continue;
    }
    if (!meta) {
      console.log('  목록에서 못 찾음 — 이름이 다를 수 있음');
      continue;
    }
    console.log(`  일련번호 ${meta.mst} · ${meta.kind ?? ''} · ${meta.status ?? ''}`);

    const params = t.target === 'law' ? ['MST', 'ID'] : ['ID', 'MST', 'LID'];
    let xml = null;
    let used = null;
    for (const p of params) {
      try {
        const res = await fetchRetry(`${BASE}/lawService.do?OC=${encodeURIComponent(OC)}&target=${t.target}&${p}=${meta.mst}&type=XML`);
        const got = await res.text();
        if (got.length > 300) { xml = got; used = p; break; }
      } catch (e) {
        console.log(`  ${p} 실패: ${e.message}`);
      }
      await sleep(300);
    }
    if (!xml) { console.log('  본문 조회 실패'); continue; }
    console.log(`  본문 ${xml.length}바이트 · 파라미터 ${used}`);

    // 1) 원문에 별표/서식 태그가 있는가
    const tags = [...new Set([...xml.matchAll(/<([^\s/>?!][^\s>]*)/g)].map((m) => m[1]))];
    const hit = tags.filter((x) => /별표|별지|서식/.test(x));
    console.log(`  태그 ${tags.length}종 · 별표/서식 관련: ${hit.length ? hit.join(', ') : '(없음)'}`);

    const doc = parser.parse(xml);
    const root = doc['법령'] ?? doc['행정규칙'] ?? Object.values(doc)[0];
    console.log(`  최상위 자식: ${Object.keys(root ?? {}).join(', ')}`);

    // 2) 지금 파서가 뽑아내는 결과
    const got = parseAnnexes(xml);
    console.log(`  parseAnnexes 결과: ${got.length}건`);
    for (const a of got.slice(0, 3)) {
      console.log(`    · [${a.kind} ${a.no ?? '?'}${a.branch ? `의${a.branch}` : ''}] ${a.title ?? '(제목없음)'}` +
        ` · 본문 ${a.text ? `${a.text.length}자` : '없음'} · PDF ${a.pdfUrl ? '있음' : '없음'} · HWP ${a.fileUrl ? '있음' : '없음'}`);
    }

    // 3) 못 뽑았으면 응답 구조를 보여준다
    if (got.length === 0) {
      const holder = Object.entries(root ?? {}).filter(([k]) => /별표|별지|서식/.test(k));
      if (!holder.length) {
        console.log('  → 응답에 별표 마디 자체가 없습니다. 별도 API 를 써야 할 수 있습니다.');
        // 조문 안에 별표가 섞여 들어왔는지 본다
        const inBody = /별표/.test(xml);
        console.log(`  → 본문 텍스트에 '별표' 라는 말: ${inBody ? '있음(참조만 있을 가능성)' : '없음'}`);
      } else {
        for (const [k, v] of holder) {
          console.log(`\n  ── "${k}" 안쪽 뼈대 ──`);
          for (const line of skeleton(v, 1).slice(0, 30)) console.log('  ' + line);
        }
      }
    }
    await sleep(400);
  }
  console.log('\n끝. 위 출력을 그대로 복사해서 전달하면 됩니다.');
}

main().catch((e) => { console.error('오류:', e.message); process.exit(1); });
