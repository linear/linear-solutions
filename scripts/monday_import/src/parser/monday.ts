/**
 * Monday.com-specific Excel parser
 * Handles the hierarchical export structure with groups, main items, and subitems
 */

import XLSX from 'xlsx';

export interface MondayItem {
  type: 'mainItem' | 'subitem';
  group: string;
  rowNumber: number;
  data: Record<string, string | null>;
  parentItem?: MondayItem; // For subitems
  subitems?: MondayItem[]; // For main items
}

export interface MondayBoard {
  name: string;
  groups: string[];
  mainItemHeaders: string[];
  subitemHeaders: string[];
  items: MondayItem[];
  headerMapping: {
    main: Map<string, number>;    // header name -> column index
    subitem: Map<string, number>; // header name -> column index
  };
}

export interface MondayUpdatesSheet {
  headers: string[];
  updates: {
    rowNumber: number;
    data: Record<string, string | null>;
  }[];
}

/**
 * Convert column index to Excel-style letter (0 -> A, 25 -> Z, 26 -> AA, etc.)
 */
export function columnIndexToLetter(index: number): string {
  let letter = '';
  let temp = index;
  
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  
  return letter;
}

/**
 * Convert Excel-style letter to column index (A -> 0, Z -> 25, AA -> 26, etc.)
 */
export function letterToColumnIndex(letter: string): number {
  let index = 0;
  for (let i = 0; i < letter.length; i++) {
    index = index * 26 + (letter.charCodeAt(i) - 64);
  }
  return index - 1;
}

/**
 * Format column for display: "A (Name)" or "B (Status)"
 */
export function formatColumn(index: number, header: string): string {
  return `${columnIndexToLetter(index)} (${header})`;
}

/**
 * Parse a Monday.com board export
 */
export function parseMondayExport(filePath: string): { board: MondayBoard; updates?: MondayUpdatesSheet } {
  const workbook = XLSX.readFile(filePath, {
    cellDates: true,
    cellNF: true,
  });

  // Find main board sheet and updates sheet
  const mainSheetName = workbook.SheetNames[0];
  const updatesSheetName = workbook.SheetNames.find(name => 
    name.toLowerCase().includes('update')
  );

  const mainSheet = workbook.Sheets[mainSheetName];
  const board = parseBoardSheet(mainSheet, mainSheetName);

  let updates: MondayUpdatesSheet | undefined;
  if (updatesSheetName) {
    const updatesSheet = workbook.Sheets[updatesSheetName];
    updates = parseUpdatesSheet(updatesSheet);
  }

  return { board, updates };
}

/**
 * Parse the main board sheet
 */
function parseBoardSheet(sheet: XLSX.WorkSheet, sheetName: string): MondayBoard {
  const data = XLSX.utils.sheet_to_json(sheet, { 
    header: 1, 
    defval: '',
    raw: false,
  }) as string[][];

  // Initialize board
  const board: MondayBoard = {
    name: '',
    groups: [],
    mainItemHeaders: [],
    subitemHeaders: [],
    items: [],
    headerMapping: {
      main: new Map(),
      subitem: new Map(),
    },
  };

  if (data.length < 3) {
    throw new Error('Sheet has too few rows to be a valid Monday.com export');
  }

  // Row 0: Board name
  board.name = String(data[0]?.[0] || sheetName).trim();

  // Find the structure by scanning rows
  let mainHeaderRow = -1;
  let subitemHeaderRow = -1;
  let currentGroup = '';
  let currentMainItem: MondayItem | null = null;

  for (let rowIdx = 0; rowIdx < data.length; rowIdx++) {
    const row = data[rowIdx];
    if (!row || row.length === 0) continue;

    const firstCell = String(row[0] || '').trim();
    const secondCell = String(row[1] || '').trim();
    
    // Skip empty rows
    if (!firstCell && !secondCell) continue;

    // Detect row type
    const rowType = detectRowType(row, firstCell, secondCell, mainHeaderRow, subitemHeaderRow);

    switch (rowType) {
      case 'boardName':
        // Already captured
        break;

      case 'groupHeader':
        currentGroup = firstCell;
        if (!board.groups.includes(currentGroup)) {
          board.groups.push(currentGroup);
        }
        break;

      case 'mainItemHeader':
        if (mainHeaderRow === -1) {
          mainHeaderRow = rowIdx;
          board.mainItemHeaders = row.map(h => String(h || '').trim()).filter(h => h);
          row.forEach((header, idx) => {
            const h = String(header || '').trim();
            if (h) {
              board.headerMapping.main.set(h, idx);
              board.headerMapping.main.set(h.toLowerCase(), idx);
            }
          });
        }
        break;

      case 'subitemHeader':
        if (subitemHeaderRow === -1 || rowIdx > subitemHeaderRow + 20) {
          // Could be repeated subitem headers for a new section
          subitemHeaderRow = rowIdx;
          if (board.subitemHeaders.length === 0) {
            board.subitemHeaders = row.map(h => String(h || '').trim()).filter(h => h);
            row.forEach((header, idx) => {
              const h = String(header || '').trim();
              if (h) {
                board.headerMapping.subitem.set(h, idx);
                board.headerMapping.subitem.set(h.toLowerCase(), idx);
              }
            });
          }
        }
        break;

      case 'mainItem':
        // Parse main item using main item headers
        const mainItemData: Record<string, string | null> = {};
        board.mainItemHeaders.forEach((header, idx) => {
          const colIdx = board.headerMapping.main.get(header);
          if (colIdx !== undefined) {
            const value = row[colIdx];
            mainItemData[header] = value ? String(value).trim() : null;
          }
        });

        currentMainItem = {
          type: 'mainItem',
          group: currentGroup,
          rowNumber: rowIdx + 1, // 1-indexed for user display
          data: mainItemData,
          subitems: [],
        };
        board.items.push(currentMainItem);
        break;

      case 'subitem':
        // Parse subitem using subitem headers
        if (currentMainItem && board.subitemHeaders.length > 0) {
          const subitemData: Record<string, string | null> = {};
          board.subitemHeaders.forEach((header) => {
            const colIdx = board.headerMapping.subitem.get(header);
            if (colIdx !== undefined) {
              const value = row[colIdx];
              subitemData[header] = value ? String(value).trim() : null;
            }
          });

          // Only add if it has a name
          const subitemName = subitemData['Name'] || subitemData['name'];
          if (subitemName) {
            const subitem: MondayItem = {
              type: 'subitem',
              group: currentGroup,
              rowNumber: rowIdx + 1,
              data: subitemData,
              parentItem: currentMainItem,
            };
            currentMainItem.subitems!.push(subitem);
            board.items.push(subitem);
          }
        }
        break;
    }
  }

  return board;
}

/**
 * Detect the type of a row in the Monday.com export
 */
function detectRowType(
  row: string[],
  firstCell: string,
  secondCell: string,
  mainHeaderRow: number,
  subitemHeaderRow: number
): 'boardName' | 'groupHeader' | 'mainItemHeader' | 'subitemHeader' | 'mainItem' | 'subitem' | 'empty' {
  // Check if row is mostly empty (group header)
  const nonEmptyCells = row.filter(cell => cell && String(cell).trim()).length;
  
  // Board name is typically row 0 with a single cell
  if (firstCell && nonEmptyCells === 1 && firstCell.length > 0 && mainHeaderRow === -1) {
    // Could be board name or first group
    if (row.length > 10) {
      return 'groupHeader'; // If there are many columns defined, it's likely a group
    }
    return 'boardName';
  }

  // Group header: single non-empty cell in first column, rest empty
  if (firstCell && nonEmptyCells === 1 && 
      firstCell.toLowerCase() !== 'name' && 
      firstCell.toLowerCase() !== 'subitems' &&
      !firstCell.startsWith('*')) {
    return 'groupHeader';
  }

  // Main item header row: first cell is "Name"
  if (firstCell.toLowerCase() === 'name' && secondCell.toLowerCase() !== 'name') {
    return 'mainItemHeader';
  }

  // Subitem header row: first cell is "Subitems" and second is "Name"
  if (firstCell.toLowerCase() === 'subitems' && secondCell.toLowerCase() === 'name') {
    return 'subitemHeader';
  }

  // If we have headers defined, determine if this is a main item or subitem
  if (mainHeaderRow !== -1) {
    // Subitem rows have "Subitems" empty in first column but have data in second column (Name)
    if (!firstCell && secondCell) {
      return 'subitem';
    }
    
    // Main item rows have data in the first column (Name)
    if (firstCell && firstCell.toLowerCase() !== 'name' && firstCell.toLowerCase() !== 'subitems') {
      return 'mainItem';
    }
  }

  return 'empty';
}

/**
 * Parse the updates sheet
 * Monday.com exports have: Row 0 = board name, Row 1 = headers, Row 2+ = data
 */
function parseUpdatesSheet(sheet: XLSX.WorkSheet): MondayUpdatesSheet {
  const data = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
  }) as string[][];

  const result: MondayUpdatesSheet = {
    headers: [],
    updates: [],
  };

  if (data.length < 3) return result;

  // Row 0 is typically board name/title, Row 1 has actual headers
  // Detect which row has headers by looking for "Item ID" or "Item Name" columns
  let headerRowIdx = 1; // Default to row 1
  for (let i = 0; i < Math.min(3, data.length); i++) {
    const row = data[i];
    // Look for specific header column names (exact match, case insensitive)
    const hasItemId = row.some(cell => 
      String(cell || '').toLowerCase() === 'item id'
    );
    const hasItemName = row.some(cell => 
      String(cell || '').toLowerCase() === 'item name'
    );
    if (hasItemId || hasItemName) {
      headerRowIdx = i;
      break;
    }
  }

  // Parse headers - keep ALL headers even empty ones for index mapping
  const headerRow = data[headerRowIdx];
  result.headers = headerRow.map(h => String(h || '').trim()).filter(h => h);

  // Parse updates (skip header row)
  for (let rowIdx = headerRowIdx + 1; rowIdx < data.length; rowIdx++) {
    const row = data[rowIdx];
    if (!row || row.every(cell => !cell || !String(cell).trim())) continue;

    const updateData: Record<string, string | null> = {};
    headerRow.forEach((header, idx) => {
      const headerName = String(header || '').trim();
      if (headerName) {
        updateData[headerName] = row[idx] !== undefined && row[idx] !== null && row[idx] !== '' 
          ? String(row[idx]).trim() 
          : null;
      }
    });

    // Only add if there's actual content (has Item ID or Item Name)
    if (updateData['Item ID'] || updateData['Item Name']) {
      result.updates.push({
        rowNumber: rowIdx + 1,
        data: updateData,
      });
    }
  }

  return result;
}

/**
 * Get summary statistics for a parsed board
 */
export function getBoardSummary(board: MondayBoard): {
  totalGroups: number;
  totalMainItems: number;
  totalSubitems: number;
  mainItemColumns: { letter: string; name: string; index: number }[];
  subitemColumns: { letter: string; name: string; index: number }[];
} {
  const mainItems = board.items.filter(i => i.type === 'mainItem');
  const subitems = board.items.filter(i => i.type === 'subitem');

  const mainItemColumns = board.mainItemHeaders.map((name, idx) => ({
    letter: columnIndexToLetter(idx),
    name,
    index: idx,
  }));

  const subitemColumns = board.subitemHeaders.map((name, idx) => ({
    letter: columnIndexToLetter(idx),
    name,
    index: idx,
  }));

  return {
    totalGroups: board.groups.length,
    totalMainItems: mainItems.length,
    totalSubitems: subitems.length,
    mainItemColumns,
    subitemColumns,
  };
}
