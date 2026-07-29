// KEAD 법령자료실 수집기
// 게시판 목록을 읽어 문서 인벤토리(inventory.json)를 만든다.
// 실행: node collect.js  (결과: data/inventory.json)

import * as cheerio from 'cheerio';
import { writeFile, mkdir } from 'node:fs/promises';

const BASE = 'https://www.kead.or.kr';

export const BOARDS = [
  { id: 'plaw',      name: '법령고시',       path: '/bbs/plaw/bbsPage.do?adt1CodeArr=1,2&menuId=MENU0795' },
  { id: 'dislaw',    name: '장애인관련법령', path: '/bbs/plaw/bbsPage.do?adt1Code=3&menuId=MENU0796' },
  { id: 'innerlaw',  name: '내부규정',       path: '/bbs/innerlaw/bbsPage.do?menuId=MENU0797' },
];

// ── 제목 파싱 ────────────────────────────────────────────────
// "장애인 취업지원 업무처리규칙(규칙 제766호, 개정: 2023. 10. 6.)"
// "장애인고용촉진 및 직업재활법 시행규칙(고용노동부령 제474호, 시행: 2026.7.1.)"
// "장애인 고용의무 불이행 명단공표제도 운영규정(고용노동부훈령 제566호, `25.11.7.개정)"
// "장애인 고용부담금의 부담기초액(2026년)"

const RE_NO = /제\s*0*(\d+)\s*호/;
const RE_DATE = /`?(\d{2,4})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})\s*\.?/;

export function normalizeDate(y, m, d) {
  let year = Number(y);
  if (year < 100) year += 2000;            // `25 → 2025
  const mm = String(Number(m)).padStart(2, '0');
  const dd = String(Number(d)).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

export function parseTitle(raw) {
  const title = raw.replace(/\s+/g, ' ').trim();

  // 마지막 괄호 덩어리를 메타로 본다 (본문 제목에 괄호가 들어가는 경우 대비)
  const m = title.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (!m) return { docName: title, lawNo: null, effectiveDate: null, dateKind: null, raw: title };

  const docName = m[1].trim();
  const meta = m[2];

  const noMatch = meta.match(RE_NO);
  const lawNo = noMatch ? Number(noMatch[1]) : null;

  const dateMatch = meta.match(RE_DATE);
  const effectiveDate = dateMatch ? normalizeDate(dateMatch[1], dateMatch[2], dateMatch[3]) : null;

  // 시행 / 개정 / 제정 구분
  let dateKind = null;
  if (/시행/.test(meta)) dateKind = '시행';
  else if (/개정/.test(meta)) dateKind = '개정';
  else if (/제정/.test(meta)) dateKind = '제정';

  // 괄호 안이 메타가 아니면(예: "부담기초액(2026년)") 문서명에 되돌린다
  if (lawNo === null && effectiveDate === null && dateKind === null) {
    return { docName: title, lawNo: null, effectiveDate: null, dateKind: null, raw: title };
  }

  return { docName, lawNo, effectiveDate, dateKind, raw: title };
}

// ── 버전 판정 ────────────────────────────────────────────────
// 같은 docName 그룹에서 시행일 기준으로 현행 / 시행예정 / 연혁을 가른다.
export function classifyVersions(items, today = new Date().toISOString().slice(0, 10)) {
  const groups = new Map();
  for (const it of items) {
    const key = it.docName;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  for (const [, list] of groups) {
    // 시행일 없으면 게시일로 대체
    const keyOf = (x) => x.effectiveDate || x.postedDate || '0000-00-00';
    list.sort((a, b) => keyOf(b).localeCompare(keyOf(a)));

    let currentFound = false;
    for (const it of list) {
      const d = keyOf(it);
      if (d > today) {
        it.status = '시행예정';
      } else if (!currentFound) {
        it.status = '현행';
        currentFound = true;
      } else {
        it.status = '연혁';
      }
    }
    // 전부 미래 시행이면 가장 이른 것을 현행 취급하지 않고 그대로 둔다(경고 대상)
  }
  return items;
}

// ── 첨부 형식 판별(확장자 아님, 실제 바이트 기준) ─────────────
export function sniffFormat(buf) {
  const b = Buffer.from(buf.slice(0, 8));
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'hwp5';   // CFB
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';                                      // PK (hwpx도 zip)
  if (b.slice(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (b.slice(0, 5).toString('latin1') === '<?xml') return 'hwpml';
  return 'unknown';
}

// ── 목록 페이지 파싱 ─────────────────────────────────────────
export function parseListHtml(html, boardId) {
  const $ = cheerio.load(html);
  const rows = [];

  $('table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;

    const title = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    if (!title) return;

    // 날짜처럼 보이는 셀을 찾는다 (열 구성이 게시판마다 다름)
    let postedDate = null;
    tds.each((__, td) => {
      const t = $(td).text().trim();
      const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m && !postedDate) postedDate = t;
    });

    // 첨부: downloadDirect.do?key=... 링크를 전부 수집
    const files = [];
    $(tr).find('a[href*="downloadDirect.do"]').each((__, a) => {
      const href = $(a).attr('href') || '';
      const key = (href.match(/key=([A-Za-z0-9]+)/) || [])[1];
      const name = $(a).find('img').attr('alt') || $(a).attr('title') || '';
      if (key) files.push({ key, name, url: `${BASE}/cmm/fms/downloadDirect.do?key=${key}` });
    });

    rows.push({ boardId, postedDate, files, ...parseTitle(title) });
  });

  return rows;
}

// ── 수집 ─────────────────────────────────────────────────────
async function fetchList(board, pageIndex) {
  const sep = board.path.includes('?') ? '&' : '?';
  const url = `${BASE}${board.path}${sep}pageIndex=${pageIndex}&recordCountPerPage=50`;
  const res = await fetch(url, { headers: { 'User-Agent': 'kead-rules-collector/0.1' } });
  if (!res.ok) throw new Error(`${board.name} p${pageIndex}: HTTP ${res.status}`);
  return res.text();
}

async function collectBoard(board, maxPages = 20) {
  const all = [];
  const seen = new Set();

  for (let p = 1; p <= maxPages; p++) {
    const html = await fetchList(board, p);
    const rows = parseListHtml(html, board.id);
    if (rows.length === 0) break;

    let added = 0;
    for (const r of rows) {
      const sig = r.raw + '|' + (r.files[0]?.key ?? '');
      if (seen.has(sig)) continue;
      seen.add(sig);
      all.push(r);
      added++;
    }
    if (added === 0) break;              // 같은 페이지가 반복되면 중단
    await new Promise((r) => setTimeout(r, 800));   // 서버 배려
  }

  console.log(`[${board.name}] ${all.length}건`);
  return all;
}

async function main() {
  const items = [];
  for (const b of BOARDS) {
    try {
      items.push(...(await collectBoard(b)));
    } catch (e) {
      console.error(`[${b.name}] 실패: ${e.message}`);
    }
  }

  classifyVersions(items);

  const manifest = {
    collectedAt: new Date().toISOString(),
    total: items.length,
    byStatus: items.reduce((acc, i) => ((acc[i.status ?? '미분류'] = (acc[i.status ?? '미분류'] || 0) + 1), acc), {}),
    noAttachment: items.filter((i) => i.files.length === 0).map((i) => i.raw),
    unparsedTitle: items.filter((i) => i.lawNo === null && i.effectiveDate === null).map((i) => i.raw),
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/inventory.json', JSON.stringify(items, null, 2));
  await writeFile('data/manifest.json', JSON.stringify(manifest, null, 2));
  console.log(manifest);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
