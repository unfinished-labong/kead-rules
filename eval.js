#!/usr/bin/env node
// 검색 품질 평가기.
//
// 서버를 실제로 띄우고 MCP 로 두드린다. 검색 함수를 흉내 내지 않고 진짜를 쓰므로,
// 2단계 검색·되묻기·약한 결과 같은 실제 동작이 그대로 점수에 반영된다.
//
//   node eval.js
//   node eval.js --index data/index-new.json          인덱스를 바꿔가며 비교
//   node eval.js --server server-v6.js                서버를 바꿔가며 비교
//   node eval.js --base result-before.json            직전 결과와 증감 표시
//   node eval.js --save result-before.json            결과를 파일로 남김
//   node eval.js --only 큰아버지                       특정 질의만
//
// 종료 코드는 hit@1 이 기준선보다 떨어지면 1. CI 에 걸어둘 수 있다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const INDEX = path.resolve(opt('index', 'data/index.json'));
const SERVER = path.resolve(opt('server', 'server.js'));
const QUERIES = path.resolve(opt('queries', 'eval-queries.json'));
const BASE = opt('base', null);
const SAVE = opt('save', null);
const ONLY = opt('only', null);
const PORT = Number(opt('port', 8790 + (process.pid % 200)));
const LIMIT = Number(opt('limit', 8));

for (const [label, p] of [['인덱스', INDEX], ['서버', SERVER], ['평가표', QUERIES]]) {
  if (!fs.existsSync(p)) {
    console.error(`${label} 파일이 없습니다: ${p}`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callTool(args, tool = 'search_provisions') {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const j = await res.json();
  return j?.result?.content?.[0]?.text ?? '';
}

// 결과 본문에서 (문서명, 조문번호) 를 순서대로 뽑는다
function parseHits(text) {
  const out = [];
  // '■ 문서명 제N조' 와 '  · 문서명 제N조 (제목)' 두 모양을 모두 받는다
  const re = /^(?:■ |\s*· )(.+?) (제[^\s(]+|\[별표[^\]]*\]|부칙[^\s]*|전문)(?:\s|\(|$)/gm;
  let m;
  while ((m = re.exec(text))) out.push({ doc: m[1].trim(), art: m[2].trim() });
  return out;
}

// 'ê·œì •ëª…|ì¡°ë¬¸' 기대값과 대조. 문서명은 부분일치, 조문번호는 앞부분 일치.
function matches(hit, want) {
  const [wd, wa] = want.split('|').map((x) => x.trim());
  if (!hit.doc.includes(wd)) return false;
  const norm = (x) => x.replace(/\s/g, '');
  return norm(hit.art).startsWith(norm(wa));
}

function classify(text) {
  if (text.startsWith('[선택 필요]')) return '물음';
  if (text.startsWith('[약한 결과]')) return '약함';
  if (text.startsWith('[NOT_FOUND]')) return '없음';
  return '답변';
}

async function main() {
  const spec = JSON.parse(fs.readFileSync(QUERIES, 'utf8'));
  let cases = spec.cases.filter((c) => !ONLY || c.q.includes(ONLY));

  const srv = spawn('node', [SERVER], {
    env: { ...process.env, INDEX_URL: 'http://127.0.0.1:9/none', INDEX_CACHE: INDEX, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  srv.stderr.on('data', (d) => (boot += d));
  srv.stdout.on('data', (d) => (boot += d));

  // 인덱스 적재를 기다린다
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) { ready = true; break; }
    } catch {}
  }
  if (!ready) {
    console.error('서버가 뜨지 않았습니다.\n' + boot.slice(0, 800));
    srv.kill();
    process.exit(2);
  }
  // 첫 호출로 인덱스 적재를 강제
  await callTool({ query: '적재확인', limit: 1 });

  const rows = [];
  for (const c of cases) {
    // 종합형은 답이 흩어져 있으므로 실제 사용처럼 넉넉히 받아 본다
    const lim = c.type === '종합' ? Math.max(LIMIT, 15) : LIMIT;
    // tool 을 지정한 질의는 그 도구로 잰다. 주기 업무처럼 전용 도구가 맞는 유형이 있다.
    const text = c.tool
      ? await callTool(c.args ?? {}, c.tool)
      : await callTool({ query: c.q, limit: lim });
    const kind = classify(text);
    const hits = parseHits(text);
    const noAnswer = (c.expect ?? []).length === 0;

    let rank = 0;
    let found = 0;
    if (!noAnswer) {
      for (let i = 0; i < hits.length; i++) {
        if (c.expect.some((w) => matches(hits[i], w))) { rank = i + 1; break; }
      }
      // 종합형은 '몇 개나 담았나' 를 본다. 절차·체크리스트는 답이 여러 조문에 흩어져 있어
      // 하나만 맞히고 통과시키면 실제 쓸모를 못 잰다.
      found = c.expect.filter((w) => hits.some((h) => matches(h, w))).length;
    }
    const need = c.type === '종합' ? Math.ceil(c.expect.length * (c.minRatio ?? 0.6)) : 1;
    const ok = noAnswer ? kind !== '답변' : (c.type === '종합' ? found >= need : rank > 0);
    rows.push({
      q: c.q, confirmed: !!c.confirmed, kind, rank, ok, noAnswer,
      type: c.type ?? '단일', found, want: c.expect.length, need,
      top: hits[0], n: hits.length,
    });
  }
  srv.kill();

  // ── 집계 ──
  const scored = rows.filter((r) => !r.noAnswer && r.type !== '종합');
  const multi = rows.filter((r) => r.type === '종합');
  const at = (k) => scored.filter((r) => r.rank > 0 && r.rank <= k).length;
  const mrr = scored.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / (scored.length || 1);
  const cnt = (k) => rows.filter((r) => r.kind === k).length;
  const sum = {
    n: scored.length,
    hit1: at(1), hit3: at(3), hit8: at(8),
    mrr: Number(mrr.toFixed(3)),
    물음: cnt('물음'), 약함: cnt('약함'), 없음: cnt('없음'),
    무관질의통과: rows.filter((r) => r.noAnswer && r.ok).length,
    무관질의수: rows.filter((r) => r.noAnswer).length,
    종합수: multi.length,
    종합통과: multi.filter((r) => r.ok).length,
    종합담김: multi.reduce((s, r) => s + r.found, 0),
    종합필요: multi.reduce((s, r) => s + r.want, 0),
  };

  // ── 출력 ──
  const mark = (r) => (r.ok ? (r.rank === 1 ? '◎' : '○') : '×');
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log(`\n인덱스 ${path.basename(INDEX)} · 서버 ${path.basename(SERVER)} · 질의 ${rows.length}건\n`);
  console.log('    ' + pad('질의', 36) + pad('판정', 6) + pad('순위/담김', 8) + '1위 결과');
  console.log('    ' + '-'.repeat(94));
  for (const r of rows) {
    const topStr = r.top ? `${r.top.doc} ${r.top.art}` : '—';
    console.log(
      `  ${mark(r)} ` + pad(r.q + (r.confirmed ? '' : ' *'), 36) +
      pad(r.kind, 6) +
      pad(r.type === '종합' ? `${r.found}/${r.want}` : (r.rank ? String(r.rank) : (r.noAnswer ? '-' : '밖')), 6) +
      topStr.slice(0, 46)
    );
  }
  console.log('    ' + '-'.repeat(94));
  console.log(`\n  hit@1 ${sum.hit1}/${sum.n}   hit@3 ${sum.hit3}/${sum.n}   hit@8 ${sum.hit8}/${sum.n}   MRR ${sum.mrr}`);
  if (sum.종합수) console.log(`  종합형 ${sum.종합통과}/${sum.종합수}건 통과 · 필요 조문 ${sum.종합담김}/${sum.종합필요}개 담김`);
  console.log(`  되묻기 ${sum.물음}건 · 약한결과 ${sum.약함}건 · 못찾음 ${sum.없음}건 · 무관질의 방어 ${sum.무관질의통과}/${sum.무관질의수}`);
  console.log('  * 표시는 정답 조문이 미확인(추정)인 질의입니다.\n');

  if (BASE && fs.existsSync(BASE)) {
    const b = JSON.parse(fs.readFileSync(BASE, 'utf8'));
    const d = (k) => { const v = sum[k] - b.sum[k]; return v > 0 ? `+${v}` : String(v); };
    console.log(`  기준선 대비: hit@1 ${d('hit1')} · hit@3 ${d('hit3')} · MRR ${(sum.mrr - b.sum.mrr).toFixed(3)} · 되묻기 ${d('물음')}`);
    const was = Object.fromEntries(b.rows.map((r) => [r.q, r]));
    for (const r of rows) {
      const o = was[r.q];
      if (!o) continue;
      if (r.type === '종합' && o.found !== undefined) {
        if (r.found > o.found) console.log(`    좋아짐  ${r.q}  (${o.found}/${r.want} → ${r.found}/${r.want}개)`);
        else if (r.found < o.found) console.log(`    나빠짐  ${r.q}  (${o.found}/${r.want} → ${r.found}/${r.want}개)`);
        continue;
      }
      if (o.ok && !r.ok) console.log(`    나빠짐  ${r.q}  (${o.rank}위 → 못찾음)`);
      else if (!o.ok && r.ok) console.log(`    좋아짐  ${r.q}  (못찾음 → ${r.rank}위)`);
      else if (o.rank && r.rank && r.rank < o.rank) console.log(`    좋아짐  ${r.q}  (${o.rank}위 → ${r.rank}위)`);
      else if (o.rank && r.rank && r.rank > o.rank) console.log(`    나빠짐  ${r.q}  (${o.rank}위 → ${r.rank}위)`);
    }
    console.log('');
  }

  if (SAVE) {
    fs.writeFileSync(SAVE, JSON.stringify({ at: new Date().toISOString(), index: INDEX, server: SERVER, sum, rows }, null, 2));
    console.log(`  결과를 ${SAVE} 에 남겼습니다.\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
