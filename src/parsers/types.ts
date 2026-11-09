export interface ParsedRow {
  date: string;
  time: string | null;
  description: string;
  moneyIn: number;
  moneyOut: number;
  /** running balance after the row, statement currency */
  balance: number;
  section: number;
}

export interface ParsedSection {
  name: string;
  periodStart: string | null;
  periodEnd: string | null;
  opening: number;
  closing: number;
  totalIn: number;
  totalOut: number;
  rowCount: number;
}

export interface ParsedStatement {
  bank: 'ABA' | 'REV';
  accountLast3: string;
  currency: 'USD' | 'GBP';
  periodStart: string;
  periodEnd: string;
  periodFromHeader: boolean;
  opening: number;
  closing: number;
  totalIn: number;
  totalOut: number;
  sections: ParsedSection[];
  rows: ParsedRow[];
  notes: string[];
}
