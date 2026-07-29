// 내부규정 첨부파일을 내려받아 조문 청크로 변환한다.
// 실행: node fetch-docs.js
// 입력: data/inventory.json   출력: data/docs/*.json, data/docs-manifest.json

import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

const run = promisify(execFile);
const TMP = 'tmp';
const OUT = 'data/docs';

// 변환 대상 상태. 연혁·폐지는 받지 않는다.
const WANTED = new Set(['현행', '시행예정']);

// ── 형식 판별: 확장자가 아니라 실제 바이트로 본다 ──
export function sniffFormat(buf) {
  const b = Buffer.from(buf.subarray(0, 8));
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'hwp';
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';            // hwpx도 zip이다
  if (b.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (b.subarray(0, 5).toString('latin1') === '<?xml') return 'hwp';
  return 'unknown';
}

// zip이면 hwpx인지 일반 압축인지 구분한다
async function refineZip(file) {
  try {
    const { stdout } = await run('unzip', ['-l', file]);
    return /mimetype|Contents\/(header|section)/i.test(stdout) ? 'hwpx' : 'zip';
  } catch {
    return 'zip';
  }
}

// ── 첨부 고르기 ──
// 한 게시글에 여러 파일이 붙는다. 개정문·신구조문대비표보다 전문(본문)을 우선한다.
export function pickAttachment(files) {
  if (!files?.length) return null;
  const score = (f) => {
    const n = f.name ?? '';
    let s = 0;
    if (/개정문|개정이유|신구조문|대비표|제개정이유/.test(n)) s -= 10;
    if (/전문|전체/.test(n)) s += 3;
    if (/\.(hwpx?|HWPX?)$/.test(n)) s += 2;
    if (/\.zip$/i.test(n)) s -= 1;
    if (/\.pdf$/i.test(n)) s -= 2;
    return s;
  };
  return [...files].sort((a, b) => score(b) - score(a))[0];
}

// ── 변환: 파일 하나 → 청크 배열 ──
export async function convertFile(file) {
  const outJson = path.join(TMP, `${path.basename(file)}.chunks.json`);
  await run('npx', ['kordoc', file, '--format', 'chunks', '-o', outJson, '--silent'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const chunks = JSON.parse(await readFile(outJson, 'utf-8'));
  return Array.isArray(chunks) ? chunks : (chunks.chunks ?? []);
}

// ── 조문 단위로 다시 묶기 ──
// kordoc 청크는 헤딩·본문이 섞여 있다. '제N조' 경계로 재정규화한다.
const ART = /제\s*(\d+)\s*조(?:의\s*(\d+))?\s*(?:\(([^)]*)\))?/;

export function toArticles(chunks) {
  const arts = [];
  let cur = null;
  for (const c of chunks) {
    const text = String(c.text ?? '').replace(/^#+\s*/, '').trim();
    if (!text) continue;
    const m = text.match(ART);
    const startsArticle = m && text.indexOf(m[0]) <= 2;
    if (startsArticle) {
      if (cur) arts.push(cur);
      cur = {
        articleNo: m[2] ? `${m[1]}의${m[2]}` : m[1],
        title: m[3] ?? null,
        breadcrumb: c.breadcrumb ?? [],
        page: c.page ?? null,
        text,
        needsOriginal: /<img|\[중첩 테이블|별표|별지/.test(text),
      };
    } else if (cur) {
      cur.text += '\n' + text;
      if (/<img|\[중첩 테이블/.test(text)) cur.needsOriginal = true;
    } else {
      // 제1조 앞의 제정·개정 이력 등은 머리말로 따로 보관
      arts.push({ articleNo: null, title: '머리말', breadcrumb: [], text, needsOriginal: false });
      cur = null;
    }
  }
  if (cur) arts.push(cur);
  return arts;
}

// ── 유사도: 문서가 같은 계열인지 본문으로 판단 ──
export function shingles(text, k = 6) {
  const s = String(text).replace(/\s+/g, '').slice(0, 4000);
  const set = new Set();
  for (let i = 0; i + k <= s.length; i++) set.add(s.slice(i, i + k));
  return set;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ── 본체 ──
async function main() {
  const inventory = JSON.parse(await readFile('data/inventory.json', 'utf-8'));
  let prev = {};
  try {
    prev = JSON.parse(await readFile('data/docs-manifest.json', 'utf-8')).byKey ?? {};
  } catch {}

  await mkdir(TMP, { recursive: true });
  await mkdir(OUT, { recursive: true });

  const targets = inventory.filter((i) => WANTED.has(i.status));
  const byKey = {};
  const failed = [];
  const docs = [];
  let reused = 0;

  for (const item of targets) {
    const att = pickAttachment(item.files);
    if (!att) {
      failed.push({ doc: item.docName, reason: '첨부 없음' });
      continue;
    }

    const outFile = path.join(OUT, `${att.key}.json`);
    // 캐시: 첨부 key가 그대로면 이미 변환된 결과를 쓴다
    if (prev[att.key] && (await stat(outFile).catch(() => null))) {
      byKey[att.key] = prev[att.key];
      docs.push(JSON.parse(await readFile(outFile, 'utf-8')));
      reused++;
      continue;
    }

    try {
      const res = await fetch(att.url, { headers: { 'User-Agent': 'kead-rules/0.3' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());

      const raw = path.join(TMP, att.key);
      await writeFile(raw, buf);
      let fmt = sniffFormat(buf);
      if (fmt === 'zip') fmt = await refineZip(raw);
      if (fmt === 'zip' || fmt === 'unknown') {
        failed.push({ doc: item.docName, file: att.name, reason: `처리 불가 형식(${fmt})` });
        continue;
      }

      const named = `${raw}.${fmt}`;
      await run('cp', [raw, named]);
      const chunks = await convertFile(named);
      const articles = toArticles(chunks);

      const doc = {
        docKey: item.docKey,
        docName: item.docName,
        status: item.status,
        lawNo: item.lawNo,
        effectiveDate: item.effectiveDate,
        dateKind: item.dateKind,
        sourceTitle: item.raw,
        fileName: att.name,
        fileFormat: fmt,
        fileKey: att.key,
        fileUrl: att.url,
        sha256: createHash('sha256').update(buf).digest('hex'),
        articleCount: articles.filter((a) => a.articleNo).length,
        needsOriginalCount: articles.filter((a) => a.needsOriginal).length,
        articles,
      };

      await writeFile(outFile, JSON.stringify(doc, null, 2));
      byKey[att.key] = { docKey: item.docKey, sha256: doc.sha256, articles: doc.articleCount };
      docs.push(doc);
      console.log(`OK  ${item.docName} · ${fmt} · 조문 ${doc.articleCount}`);
      await new Promise((r) => setTimeout(r, 600));
    } catch (e) {
      failed.push({ doc: item.docName, file: att.name, reason: e.message });
      console.error(`FAIL ${item.docName}: ${e.message}`);
    }
  }

  // 본문이 매우 비슷한데 문서키가 다른 쌍 = 병합 후보
  const sigs = docs.map((d) => ({
    key: d.docKey,
    name: d.docName,
    sh: shingles(d.articles.map((a) => a.text).join(' ')),
  }));
  const mergeCandidates = [];
  for (let i = 0; i < sigs.length; i++)
    for (let j = i + 1; j < sigs.length; j++) {
      if (sigs[i].key === sigs[j].key) continue;
      const s = jaccard(sigs[i].sh, sigs[j].sh);
      if (s >= 0.85) mergeCandidates.push({ similarity: Number(s.toFixed(3)), a: sigs[i].name, b: sigs[j].name });
    }
  mergeCandidates.sort((x, y) => y.similarity - x.similarity);

  await writeFile(
    'data/docs-manifest.json',
    JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        targets: targets.length,
        converted: docs.length,
        reusedFromCache: reused,
        totalArticles: docs.reduce((s, d) => s + d.articleCount, 0),
        needsOriginal: docs.reduce((s, d) => s + d.needsOriginalCount, 0),
        failed,
        mergeCandidates,
        byKey,
      },
      null,
      2
    )
  );
  await rm(TMP, { recursive: true, force: true });
  console.log(`\n대상 ${targets.length} / 변환 ${docs.length} (캐시 재사용 ${reused}) / 실패 ${failed.length}`);
  if (mergeCandidates.length) console.log(`병합 후보 ${mergeCandidates.length}쌍 — manifest 확인`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
