import { strToU8, zipSync } from 'fflate';

const EXPORT_COLUMNS = [
  { header: 'Date', key: 'date', width: 14 },
  { header: 'Merchant', key: 'merchant', width: 28 },
  { header: 'Category', key: 'category', width: 20 },
  { header: 'Source', key: 'source', width: 34 },
  { header: 'Status', key: 'status', width: 18 },
  { header: 'Direction / type', key: 'direction', width: 20 },
  { header: 'Amount', key: 'amount', width: 16 },
  { header: 'Currency', key: 'currency', width: 12 }
];

function exportDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || '');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function transactionAmount(item) {
  const amount = Math.abs(Number(item.amount) || 0);
  if (item.sourceType === 'manual') {
    if (item.type === 'expense' || item.type === 'cash') return -amount;
    return amount;
  }
  return item.direction === 'credit' ? amount : -amount;
}

function transactionDirection(item) {
  if (item.sourceType === 'manual') {
    return {
      income: 'Income',
      expense: 'Expense',
      cash: 'Cash',
      transfer: 'Transfer',
      adjustment: 'Adjustment'
    }[item.type] || 'Manual entry';
  }
  return item.direction === 'credit' ? 'Credit' : 'Debit';
}

function xml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  })[character]);
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function excelDateSerial(date) {
  return date.getTime() / 86400000 + 25569;
}

function sheetCell(value, reference, style = 0) {
  const styleAttribute = style ? ` s="${style}"` : '';
  if (value instanceof Date) return `<c r="${reference}" s="2"><v>${excelDateSerial(value)}</v></c>`;
  if (typeof value === 'number') return `<c r="${reference}"${styleAttribute}><v>${value}</v></c>`;
  return `<c r="${reference}" t="inlineStr"${styleAttribute}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

export function transactionExportRows(items) {
  return items.map((item) => ({
    date: exportDate(item.dateValue),
    merchant: item.name || '',
    category: item.category || 'Other',
    source: item.source || '',
    status: item.status || '',
    direction: transactionDirection(item),
    amount: transactionAmount(item),
    currency: item.currency || 'EGP'
  }));
}

function worksheetXml(items) {
  const rows = transactionExportRows(items);
  const headerCells = EXPORT_COLUMNS.map((column, index) => sheetCell(column.header, `${columnName(index)}1`, 1)).join('');
  const dataRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = EXPORT_COLUMNS.map((column, columnIndex) => {
      const style = column.key === 'amount' ? 3 : 0;
      return sheetCell(row[column.key], `${columnName(columnIndex)}${rowNumber}`, style);
    }).join('');
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join('');
  const lastRow = Math.max(1, rows.length + 1);
  const columns = EXPORT_COLUMNS.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${columns}</cols>
  <sheetData><row r="1" ht="24" customHeight="1">${headerCells}</row>${dataRows}</sheetData>
  <autoFilter ref="A1:H${lastRow}"/>
</worksheet>`;
}

function workbookFiles(items, exportedAt) {
  const timestamp = exportedAt.toISOString();
  return {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Zoid Bank</Application></Properties>`,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Zoid Bank</dc:creator><dc:subject>Filtered transaction export</dc:subject><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Transactions" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="#,##0.00;[Red]-#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF171717"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    'xl/worksheets/sheet1.xml': worksheetXml(items)
  };
}

export async function createTransactionsWorkbook(items, { exportedAt = new Date() } = {}) {
  const files = Object.fromEntries(Object.entries(workbookFiles(items, exportedAt))
    .map(([path, content]) => [path, strToU8(content)]));
  return zipSync(files, { level: 6 });
}

export function transactionExportFilename(exportedAt = new Date()) {
  const date = exportedAt.toISOString().slice(0, 10);
  return `zoid-bank-transactions-${date}.xlsx`;
}

export async function downloadTransactionsWorkbook(items, { exportedAt = new Date() } = {}) {
  const data = await createTransactionsWorkbook(items, { exportedAt });
  const filename = transactionExportFilename(exportedAt);
  const url = URL.createObjectURL(new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}
