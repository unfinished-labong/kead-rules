// 법제처 법령(data/laws.json)과 내부규정(data/docs/*.json)을 하나로 합친다.
// 실행: node build-index.js   출력: data/index.json
//
// MCP 서버는 이 파일 하나만 읽는다. 역색인은 두지 않고 서버가 선형 스캔한다.
// 조문 5천 개 수준에서는 그게 더 단순하고 충분히 빠르다.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { toArticles } from './fetch-docs.js';
import path from 'node:path';

// 검색용 정규화: 공백·구두점을 없애 표기 흔들림을 흡수한다.
// 변환기가 붙여주는 breadcrumb 에는 장·절 제목 말고도 문서명이나
// 앞 조문 본문이 섞여 들어온다. '제N장/절/관/편' 으로 시작하는 것만 남긴다.
const CHAPTER_RE = /^제\s*\d+\s*[장절관편]/;
function chapterOf(breadcrumb) {
  if (!Array.isArray(breadcrumb)) return null;
  const ch = breadcrumb
    .map((x) => String(x ?? '').replace(/\s+/g, ' ').trim())
    .filter((x) => CHAPTER_RE.test(x));
  return ch.length ? ch.join(' > ') : null;
}

export function normText(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[·ㆍ‧∙・]/g, '')
    .replace(/[^가-힣A-Za-z0-9]/g, '')
    .toLowerCase();
}

// 행정규칙 폴백은 XML 메타데이터(일련번호, 부처코드, 담당자 이름·전화)까지 딸려온다.
// 본문이 시작되기 전의 코드·숫자·연락처 줄을 걷어낸다.
export function stripApiMeta(text) {
  const lines = String(text ?? '').split('\n');
  // 메타를 하나씩 지우는 대신, 본문이 시작되는 첫 줄을 찾아 그 앞을 통째로 버린다.
  const looksLikeBody = (l) =>
    /^\d+\s*[.)]\s*\S/.test(l) ||           // 1. 산정기준
    /^[○◇ㅇ□▪△▶•·※-]\s*\S/.test(l) ||        // ○ 부담기초액
    /^제\s*\d+\s*조/.test(l) ||               // 제1조(목적)
    /^[가-힣]\s*[.)]\s*\S/.test(l) ||         // 가. 나.
    (l.length > 30 && /\s/.test(l));           // 문장으로 보이는 긴 줄

  const limit = Math.min(lines.length, 40);
  for (let i = 0; i < limit; i++) {
    if (looksLikeBody(lines[i].trim())) {
      return lines.slice(i).join('\n').trim();
    }
  }
  return String(text ?? '').trim();
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
      const isAnnex = a.section === '별표';
      if ((!a.articleId && !isAnnex) || isNoise(a.text)) continue;
      const label = a.articleId ?? a.annexTitle ?? '별표';
      articles.push({
        id: `${docId}#${a.section}:${label}`,
        docId,
        section: a.section,
        articleId: label,
        title: a.title,
        text: a.text,
        chapter: chapterOf(a.breadcrumb),
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
    // 법령은 조문번호가 오지만, 고시·훈령(행정규칙)은 통짜 텍스트로 온다.
    // 번호가 없으면 내부규정과 같은 방식으로 직접 조문을 쪼갠다.
    const numbered = d.articles.filter((a) => a.articleNo != null && !isNoise(a.text));
    let parsed =
      numbered.length > 0
        ? numbered.map((a) => ({
            section: '본칙',
            articleId: `제${a.articleNo}조`,
            title: a.title ?? null,
            text: a.text,
            needsOriginal: /별표|별지|서식/.test(a.text),
          }))
        : toArticles(d.articles.map((a) => ({ text: a.text })))
            .filter((a) => a.articleId)
            .map((a) => ({
              section: a.section,
              articleId: a.articleId,
              title: a.title,
              text: a.text,
              needsOriginal: a.needsOriginal,
            }));

    // 조문 형식이 아닌 고시(부담기초액, 구매목표 비율 등)는 전문을 하나의 검색 단위로 넣는다.
    if (parsed.length === 0) {
      const whole = stripApiMeta(d.articles.map((a) => a.text).join('\n')).slice(0, 12000);
      if (whole.length >= 30) {
        parsed.push({
          section: '본칙',
          articleId: '전문',
          title: d.docName,
          text: whole,
          needsOriginal: /별표|별지|서식/.test(whole),
        });
      }
    }

    for (const a of parsed) {
      if (isNoise(a.text)) continue;
      articles.push({
        id: `${docId}#${a.section}:${a.articleId}`,
        docId,
        section: a.section,
        articleId: a.articleId,
        title: a.title ?? null,
        text: a.text,
        needsOriginal: !!a.needsOriginal,
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
    articles.push({ ...a, chapter: a.chapter ?? null, norm: normText(`${a.articleId} ${a.title ?? ''} ${a.chapter ?? ''} ${a.text}`) });
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
        별표: articles.filter((a) => a.section === '별표').length,
      },
      needsOriginal: articles.filter((a) => a.needsOriginal).length,
      emptyDocs: docs.filter((d) => !articles.some((a) => a.docId === d.docId)).map((d) => d.name),
      longest: Math.max(...articles.map((a) => a.text.length)),
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
