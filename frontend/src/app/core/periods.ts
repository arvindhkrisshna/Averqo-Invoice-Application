import { todayISO } from './format';

export interface Period {
  from: string;
  to: string;
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate(); // m is 1-12

/** The year the Indian financial year (April to March) containing this date starts in. */
export function fyOf(date = todayISO()): number {
  const y = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 4 ? y : y - 1;
}

export function fyLabel(startYear: number): string {
  return `${startYear}–${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function monthPeriod(y: number, m: number): Period {
  return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)), label: `${MONTHS[m - 1]} ${y}` };
}

/** The 12 months of a financial year, April first. */
export function fyMonths(startYear: number): Period[] {
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((i + 3) % 12) + 1;
    return monthPeriod(m >= 4 ? startYear : startYear + 1, m);
  });
}

/** The 4 quarters of a financial year: Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar. */
export function fyQuarters(startYear: number): Period[] {
  return [0, 1, 2, 3].map((q) => {
    const m = [4, 7, 10, 1][q];
    const y = q === 3 ? startYear + 1 : startYear;
    return { from: iso(y, m, 1), to: iso(y, m + 2, lastDay(y, m + 2)), label: `${MONTHS[m - 1]}–${MONTHS[m + 1]} ${y}` };
  });
}

export const RANGE_PRESETS = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'this-quarter', label: 'This quarter' },
  { key: 'last-quarter', label: 'Last quarter' },
  { key: 'this-fy', label: 'This financial year' },
  { key: 'last-fy', label: 'Last financial year' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom dates' },
];

export function presetRange(key: string, today = todayISO()): { from: string; to: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const fy = fyOf(today);
  const qIndex = [3, 3, 3, 0, 0, 0, 1, 1, 1, 2, 2, 2][m - 1];
  switch (key) {
    case 'this-month':
      return monthPeriod(y, m);
    case 'last-month':
      return m === 1 ? monthPeriod(y - 1, 12) : monthPeriod(y, m - 1);
    case 'this-quarter':
      return fyQuarters(fy)[qIndex];
    case 'last-quarter':
      return qIndex === 0 ? fyQuarters(fy - 1)[3] : fyQuarters(fy)[qIndex - 1];
    case 'last-fy':
      return { from: iso(fy - 1, 4, 1), to: iso(fy, 3, 31) };
    case 'all':
      return { from: '2000-01-01', to: iso(y + 1, 12, 31) };
    default:
      return { from: iso(fy, 4, 1), to: iso(fy + 1, 3, 31) };
  }
}
