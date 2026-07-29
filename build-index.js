// 법제처 법령(data/laws.json)과 내부규정(data/docs/*.json)을 하나로 합친다.
// 실행: node build-index.js   출력: data/index.json
//
// MCP 서버는 이 파일 하나만 읽는다. 역색인은 두지 않고 서버가 선형 스캔한다.
// 조문 5천 개 수준에서는 그게 더 단순하고 충분히 빠르다.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// 검색용 정규화: 공백·구두점을 없애 표기 흔들림을 흡수한다.
export function normText(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[·ㆍ‧∙・]/g, '')
    .replace(/[^가-힣A-Za-z0-9]/g, '')
    .toLowerCase();
}

// 목차 표처럼 본문이 아닌 조각을 걸러낸다.
function isNoise(text) {
  const t = String(text ?? '').trim();
  if (t.length < 10) return true;
  if (/^(<tr|<table|\||<\/)/.test(t)) return true;
  return false;
}

async function loadInternal() {
  let files = [];
  try {
    files = (await readdir('data/docs')).filter((f) => f.endsWith('.json'));
  } catch {
    return { docs: [], articles: [] };
  }

  const docs = [];
  const articles = [];
  for (const f of files) {
    const d = JSON.parse(await readFile(path.join('data/docs', f), 'utf-8'));
    const docId = `내규:${d.docKey}:${d.fileKey}`;
    docs.push({
      docId,
      source: '공단 내부규정',
      name: d.docName,
      kind: null,
      status: d.status,
      lawNo: d.lawNo,
      effectiveDate: d.effectiveDate,
      dateKind: d.dateKind,
      originalUrl: d.fileUrl,
      fileName: d.fileName,
    });
    for (const a of d.articles) {
      if (!a.articleId || isNoise(a.text)) continue;
      articles.push({
        id: `${docId}#${a.section}:${a.articleId}`,
        docId,
        section: a.section,
        articleId: a.articleId,
        title: a.title,
        text: a.text,
        needsOriginal: !!a.needsOriginal,
      });
    }
  }
  return { docs, articles };
}

async function loadStatutes() {
  let laws = [];
  try {
    laws = JSON.parse(await readFile('data/laws.json', 'utf-8'));
  } catch {
    return { docs: [], articles: [] };
  }

  const docs = [];
  const articles = [];
  for (const d of laws) {
    const docId = `법령:${d.mst}`;
    docs.push({
      docId,
      source: '법제처',
      name: d.docName,
      kind: d.kind,
      status: d.status,
      lawNo: d.lawNo,
      effectiveDate: d.effectiveDate,
      dateKind: '시행',
      originalUrl: d.link,
      fileName: null,
    });
    for (const a of d.articles) {
      if (isNoise(a.text)) continue;
      const label = a.articleNo ? `제${a.articleNo}조` : null;
      if (!label) continue;
      articles.push({
        id: `${docId}#본칙:${label}`,
        docId,
        section: '본칙',
        articleId: label,
        title: a.title ?? null,
        text: a.text,
        needsOriginal: /별표|별지|서식/.test(a.text),
      });
    }
  }
  return { docs, articles };
}

async function main() {
  const internal = await loadInternal();
  const statutes = await loadStatutes();

  const docs = [...statutes.docs, ...internal.docs];
  const raw = [...statutes.articles, ...internal.articles];

  // 같은 문서 안에서 조문 식별자가 겹치면 뒤엣것을 버린다(변환 잡음 방어)
  const seen = new Set();
  const articles = [];
  for (const a of raw) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    articles.push({ ...a, norm: normText(`${a.articleId} ${a.title ?? ''} ${a.text}`) });
  }

  const index = {
    builtAt: new Date().toISOString(),
    dataAsOf: new Date().toISOString().slice(0, 10),
    counts: {
      docs: docs.length,
      articles: articles.length,
      byScope: {
        법제처: articles.filter((a) => a.docId.startsWith('법령:')).length,
        내부규정: articles.filter((a) => a.docId.startsWith('내규:')).length,
      },
      bySection: {
        본칙: articles.filter((a) => a.section === '본칙').length,
        부칙: articles.filter((a) => a.section === '부칙').length,
      },
      needsOriginal: articles.filter((a) => a.needsOriginal).length,
    },
    docs,
    articles,
  };

  await writeFile('data/index.json', JSON.stringify(index));
  const mb = (JSON.stringify(index).length / 1024 / 1024).toFixed(1);
  console.log(`문서 ${docs.length} / 조문 ${articles.length} / 파일 ${mb}MB`);
  console.log(JSON.stringify(index.counts, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
