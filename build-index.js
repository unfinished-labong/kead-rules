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

// 장(제N장)은 breadcrumb 에 안 실린다. 절이 있으면 절이 그 자리를 차지하기 때문이다.
// 다행히 장 제목 줄은 본문에 그대로 남아 있어, 순서대로 훑으면 되살릴 수 있다.
// 이 값은 뷰어 목차 전용이다. norm 에도 검색 점수에도 넣지 않는다(아래 norm 참고).
//
// 표기가 제각각이다. 실측으로 확인한 것들:
//   '제1장 총칙' / '제1장총칙'(공백 없음, 12건) / '제 2 장 …'(글자 사이 벌어짐)
//   '제5장의 2 연봉제'(장에 가지번호) / '제4장 성과급 [장제목개정 …]'(개정 이력 꼬리)
// 그래서 장 뒤 공백을 요구하면 안 된다. 대신 조사가 이어지는 줄을 걷어내
// '제2장의 규정에 따라…' 같은 본문 줄을 장 제목으로 오인하지 않게 막는다.
const JANG_RE = /^\s*제\s*(\d+)\s*장(?:\s*의\s*(\d+))?\s*(.*)$/;
// '<삭 제 2017. 12. 29.>' 처럼 글자 사이가 벌어진 표기가 섞여 있다.
const JANG_TAG = /[<[]\s*[^<>[\]]*?(?:개\s*정|신\s*설|삭\s*제|전\s*문\s*개\s*정)[^<>[\]]*[>\]]/g;
function jangTitle(line) {
  const m = line.match(JANG_RE);
  if (!m) return null;
  const rest = m[3];
  if (/^[의은는이가을를에과와로도만]/.test(rest)) return null;   // 조사가 붙으면 본문 줄이다
  if (/[다요]\.\s*$/.test(rest)) return null;                    // 서술로 끝나면 본문 줄이다
  const head = `제${m[1]}장${m[2] ? `의${m[2]}` : ''}`;
  const title = rest.replace(JANG_TAG, '').replace(/\s+/g, ' ').trim();
  const t = title ? `${head} ${title}` : head;
  // 60자를 넘으면 장 제목이 아니라 본문 줄을 잘못 집은 것으로 본다.
  return t.length <= 60 ? t : null;
}
// 순서대로 훑으며 각 조문이 속한 장을 정한다.
// 장 제목 줄은 보통 '직전 조문 본문의 꼬리'에 붙어 오지만, 법제처 자료처럼
// '그 조문 본문의 첫 줄'로 오기도 한다. 앞에 본문이 없으면 그 조문부터 적용한다.
// 문서 첫머리(머리말)에 제1장이 들어 있는 일도 많아, 조문이 아닌 마디도 함께 훑는다.
function topChapters(rawList) {
  let cur = null;
  return rawList.map((a) => {
    let here = cur;
    let seenBody = false;
    for (const l of String(a.text ?? '').split('\n')) {
      const t = jangTitle(l);
      if (t) {
        cur = t;
        if (!seenBody) here = t;
      } else if (l.trim()) {
        seenBody = true;
      }
    }
    return here;
  });
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
    const tops = topChapters(d.articles);
    for (const [i, a] of d.articles.entries()) {
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
        // 별표·부칙은 앞 장을 물려받지 않는다. 본칙의 장에 딸린 자료가 아니다.
        chapterTop: a.section === '본칙' ? tops[i] : null,
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
    // 장 제목은 조문번호가 없는 별도 마디로 오는 일이 있다(법제처 자료의 '제1장 총칙').
    // 걸러내기 전에 원본 순서 그대로 훑어야 그 장이 사라지지 않는다.
    const rawTops = topChapters(d.articles);
    const numbered = d.articles
      .map((a, i) => ({ a, top: rawTops[i] }))
      .filter(({ a }) => a.articleNo != null && !isNoise(a.text));
    let parsed =
      numbered.length > 0
        ? numbered.map(({ a, top }) => ({
            section: '본칙',
            articleId: `제${a.articleNo}조`,
            title: a.title ?? null,
            text: a.text,
            __top: top,
            needsOriginal: /별표|별지|서식/.test(a.text),
          }))
        : (() => {
            // 쪼갠 결과에서 머리말(조문번호가 없는 마디)을 버리기 전에 장을 먼저 읽는다.
            // '제1장 총칙' 이 거기에만 들어 있는 문서가 있다.
            const all = toArticles(d.articles.map((a) => ({ text: a.text })));
            const t = topChapters(all);
            return all
              .map((a, i) => ({ ...a, __top: t[i] }))
              .filter((a) => a.articleId)
              .map((a) => ({
                section: a.section,
                articleId: a.articleId,
                title: a.title,
                text: a.text,
                __top: a.__top,
                needsOriginal: a.needsOriginal,
              }));
          })();

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

    // 별표·서식. 본문을 못 받은 것은 제목과 원문 링크만이라도 남긴다.
    // '별표 2가 아예 없다' 보다 '별표 2는 있고 원문은 여기' 가 훨씬 낫다.
    for (const x of d.annexes ?? []) {
      const no = `${x.no ?? ''}${x.branch ? `의${x.branch}` : ''}`.trim();
      const articleId = `[${x.kind ?? '별표'}${no ? ` ${no}` : ''}]`;
      const link = x.pdfUrl ?? x.fileUrl ?? null;
      const body =
        x.text ??
        `(본문을 텍스트로 받지 못했습니다. 원문에서 확인하십시오.${link ? `\n원문: ${link}` : ''})`;
      parsed.push({ __annex: true, section: '별표', articleId, title: x.title ?? null, text: body, needsOriginal: !x.text, link });
    }

    const tops = topChapters(parsed);
    for (const [i, a] of parsed.entries()) {
      if (!a.__annex && isNoise(a.text)) continue;
      articles.push({
        id: `${docId}#${a.section}:${a.articleId}`,
        docId,
        section: a.section,
        articleId: a.articleId,
        title: a.title ?? null,
        text: a.text,
        chapterTop: a.section === '본칙' ? a.__top ?? tops[i] : null,
        needsOriginal: !!a.needsOriginal,
        ...(a.link ? { link: a.link } : {}),
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
  // chapterTop 은 norm 에 넣지 않는다. 뷰어 목차 표시 전용이고, 검색 점수를 흔들면
  // 이 변경이 표시를 고친 것인지 순위를 바꾼 것인지 가릴 수 없게 된다.
  for (const a of raw) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    articles.push({ ...a, chapter: a.chapter ?? null, chapterTop: a.chapterTop ?? null, norm: normText(`${a.articleId} ${a.title ?? ''} ${a.chapter ?? ''} ${a.text}`) });
  }

  const index = {
    builtAt: new Date().toISOString(),
    // 수집일은 한국 날짜로 적는다.
    // toISOString 은 UTC 라서, 워크플로가 한국시간 새벽 5시(=UTC 20시)에 돌면
    // 날짜가 하루 전으로 찍힌다. 사용자가 보는 '최신 확인일' 이므로 KST 가 맞다.
    dataAsOf: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10),
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
