/**
 * CSV 解析（RFC4180 子集），题库导入专用，零新依赖。
 * 只做「文本 → 二维数组」：不猜分隔符、不转类型；列语义与行号由导入层负责。
 * 支持 BOM、CRLF/LF、双引号包裹、字段内换行/逗号、`""` 转义。
 */
export class CsvParseError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(message);
    this.name = 'CsvParseError';
    this.line = line;
  }
}

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* CRLF 的 \r 丢掉 */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; line++; }
    else field += ch;
  }

  if (inQuotes) throw new CsvParseError(line, '存在未闭合的双引号');
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
