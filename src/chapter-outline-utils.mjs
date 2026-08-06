export function parseChapterOutlineResponse(content) {
  const text = String(content || "").trim();
  if (!text) {
    throw new Error("DeepSeek 没有返回目录分析结果");
  }

  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error("DeepSeek 目录分析结果不是有效的 JSON 对象");
  }

  try {
    return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    throw new Error(`DeepSeek 目录分析 JSON 无法解析：${error.message}`, { cause: error });
  }
}

export function chapterOutlineStatus(result) {
  const status = String(result?.status || "").trim().toLowerCase();
  if (status === "ready") {
    return "ready";
  }
  if (status === "need_more" || status === "need-more") {
    return "need_more";
  }
  return "failed";
}

export function buildChapterOutlineRanges(result, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("无法读取 PDF 的总页数");
  }
  if (chapterOutlineStatus(result) !== "ready") {
    throw new Error(String(result?.reason || "DeepSeek 尚未完成目录分析"));
  }
  const mapping = result.pageMapping;
  const pdfPage = Number(mapping?.pdfPage);
  const printedPage = Number(mapping?.printedPage);
  const offset = Number(mapping?.offset);
  if (
    !Number.isInteger(pdfPage) ||
    !Number.isInteger(printedPage) ||
    !Number.isInteger(offset) ||
    pdfPage - printedPage !== offset
  ) {
    throw new Error("DeepSeek 返回的正文页码与 PDF 页码对应关系不一致");
  }

  const warnings = [];
  let pageMismatch = false;
  const rawChapters = Array.isArray(result.chapters) ? result.chapters : [];
  const chapterCandidates = [];
  for (let index = 0; index < rawChapters.length; index += 1) {
    const chapter = rawChapters[index];
    const number = Number(chapter?.number);
    const printedStartPage = Number(chapter?.printedStartPage);
    const title = String(chapter?.title || `Chapter ${number || index + 1}`).trim();
    if (!Number.isInteger(number) || number < 1) {
      continue;
    }
    if (!Number.isInteger(printedStartPage) || printedStartPage < 1) {
      pageMismatch = true;
      continue;
    }
    chapterCandidates.push({
      number,
      title,
      printedStartPage,
      pdfStartPage: printedStartPage + offset,
    });
  }

  chapterCandidates.sort(
    (left, right) => left.pdfStartPage - right.pdfStartPage || left.number - right.number,
  );
  const chapters = [];
  const seenNumbers = new Set();
  const seenStarts = new Set();
  for (const chapter of chapterCandidates) {
    if (seenNumbers.has(chapter.number)) {
      continue;
    }
    if (seenStarts.has(chapter.pdfStartPage)) {
      pageMismatch = true;
      continue;
    }
    seenNumbers.add(chapter.number);
    seenStarts.add(chapter.pdfStartPage);
    chapters.push(chapter);
  }
  if (chapters.length === 0) {
    pageMismatch = true;
  }

  const inDocumentChapters = chapters.filter((chapter) => {
    if (chapter.pdfStartPage < 1) {
      pageMismatch = true;
      return false;
    }
    return chapter.pdfStartPage <= pageCount;
  });
  const beyondDocument = chapters.filter((chapter) => chapter.pdfStartPage > pageCount);
  if (beyondDocument.length > 0) {
    pageMismatch = true;
  }

  let backMatter = null;
  if (result.backMatter !== null && result.backMatter !== undefined) {
    const printedStartPage = Number(result.backMatter?.printedStartPage);
    if (!Number.isInteger(printedStartPage) || printedStartPage < 1) {
      pageMismatch = true;
    } else {
      const pdfStartPage = printedStartPage + offset;
      if (pdfStartPage > pageCount) {
        pageMismatch = true;
      } else if (inDocumentChapters.length === 0) {
        pageMismatch = true;
      } else if (
        inDocumentChapters.length > 0 &&
        pdfStartPage <= inDocumentChapters.at(-1).pdfStartPage
      ) {
        pageMismatch = true;
      } else if (pdfStartPage >= 1) {
        backMatter = {
          title: String(result.backMatter?.title || "最后一章之后的内容").trim(),
          pdfStartPage,
        };
      }
    }
  }

  const ranges = [];
  if (inDocumentChapters.length === 0) {
    ranges.push({
      start: 1,
      end: pageCount,
      type: "front_matter",
      title: "当前 PDF 中可用的内容",
    });
  } else if (inDocumentChapters[0].pdfStartPage > 1) {
    ranges.push({
      start: 1,
      end: inDocumentChapters[0].pdfStartPage - 1,
      type: "front_matter",
      title: "第一章之前的内容",
    });
  }
  for (let index = 0; index < inDocumentChapters.length; index += 1) {
    const chapter = inDocumentChapters[index];
    const nextStart =
      inDocumentChapters[index + 1]?.pdfStartPage || backMatter?.pdfStartPage || pageCount + 1;
    ranges.push({
      start: chapter.pdfStartPage,
      end: nextStart - 1,
      type: "chapter",
      title: `Chapter ${chapter.number} ${chapter.title}`.trim(),
    });
  }
  if (backMatter) {
    ranges.push({
      start: backMatter.pdfStartPage,
      end: pageCount,
      type: "back_matter",
      title: backMatter.title,
    });
  }

  if (pageMismatch) {
    warnings.push("目录页码与当前 PDF 的实际页数存在不一致，请检查自动填写的分块范围。");
  }

  return { ranges, warnings };
}

export function buildPageMarkedMarkdown(pages) {
  return [...pages]
    .sort((left, right) => left.pdfPage - right.pdfPage)
    .map(({ pdfPage, markdown }) => {
      const clean = String(markdown || "")
        .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[图片数据已省略]")
        .trim();
      return `--- PDF_PAGE: ${pdfPage} ---\n${clean || "[本页没有识别到文字]"}`;
    })
    .join("\n\n");
}
