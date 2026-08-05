export const PDF_SPLIT_THRESHOLD = 50;
export const PDF_MAX_PAGES_PER_PART = 100;

export function parsePdfRangeRules(value) {
  const normalized = String(value || "")
    .replace(/\s*([-–—~～]|至)\s*/g, "$1")
    .trim();

  if (!normalized) {
    return [];
  }

  return normalized
    .split(/[\s,，;；]+/)
    .filter(Boolean)
    .map((token) => {
      const match = token.match(/^(\d+)(?:[-–—~～]|至)(\d+)$/);
      const singlePage = token.match(/^(\d+)$/);
      if (!match && !singlePage) {
        throw new Error(`无法识别“${token}”，请使用“起始页-结束页”的格式。`);
      }

      const start = Number(match?.[1] || singlePage[1]);
      const end = Number(match?.[2] || singlePage[1]);
      return { start, end };
    });
}

export function validatePdfRanges(
  ranges,
  pageCount,
  maxPagesPerPart = PDF_MAX_PAGES_PER_PART,
) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("无法读取 PDF 的总页数。");
  }
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error("请至少输入一个页码范围。");
  }

  const normalized = ranges.map((range, index) => {
    const start = Number(range?.start);
    const end = Number(range?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`第 ${index + 1} 部分的页码必须是整数。`);
    }
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      throw new Error(`第 ${index + 1} 部分超出 PDF 页码范围 1-${pageCount}。`);
    }
    if (start > end) {
      throw new Error(`第 ${index + 1} 部分的起始页不能大于结束页。`);
    }

    const length = end - start + 1;
    if (length > maxPagesPerPart) {
      throw new Error(`第 ${index + 1} 部分有 ${length} 页，每部分最多 ${maxPagesPerPart} 页。`);
    }
    return { start, end };
  });

  normalized.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (current.start <= previous.end) {
      throw new Error(
        `页码范围 ${previous.start}-${previous.end} 与 ${current.start}-${current.end} 存在重叠。`,
      );
    }
  }

  return normalized;
}

export function createDefaultPdfRanges(pageCount, maxPagesPerPart = PDF_MAX_PAGES_PER_PART) {
  const ranges = [];
  for (let start = 1; start <= pageCount; start += maxPagesPerPart) {
    ranges.push({ start, end: Math.min(pageCount, start + maxPagesPerPart - 1) });
  }
  return ranges;
}

export function formatPdfRangeRules(ranges) {
  return ranges.map(({ start, end }) => `${start}-${end}`).join("\n");
}

export function countSelectedPages(ranges) {
  return ranges.reduce((total, { start, end }) => total + end - start + 1, 0);
}

export function shouldAutoFillPdfRangeEnd(start, pageCount, threshold = 50) {
  const firstPage = Number(start);
  return (
    Number.isInteger(firstPage) &&
    Number.isInteger(pageCount) &&
    firstPage >= 1 &&
    firstPage <= pageCount &&
    pageCount - firstPage + 1 < threshold
  );
}

export function createNextPdfRangeDraft(
  previousEnd,
  pageCount,
  options = {},
) {
  const start = Number(previousEnd) + 1;
  if (!Number.isInteger(start) || start < 1 || start > pageCount) {
    return null;
  }
  const allowAutoFill = options.allowAutoFill !== false;
  return {
    start,
    end: allowAutoFill && shouldAutoFillPdfRangeEnd(start, pageCount) ? pageCount : null,
  };
}

export function mergeMarkdownParts(parts, separator = "\n\n") {
  const merged = parts
    .map((part) => String(part || "").replace(/^[\r\n]+|[\r\n]+$/g, ""))
    .filter((part) => part.trim().length > 0)
    .join(separator)
    .replace(/[\r\n]+$/g, "");
  return merged ? `${merged}\n` : "";
}
