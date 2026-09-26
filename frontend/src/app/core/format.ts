import { Invoice } from './models';

// ---------- Dates (always the user's local calendar day) ----------

export function todayISO(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return toISO(d);
}

export function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return toISO(new Date(y, m - 1, d + days));
}

export function daysBetween(fromISO: string, toISODate: string): number {
  const [a, b] = [fromISO, toISODate].map((s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  });
  return Math.round((b - a) / 86_400_000);
}

// ---------- Invoice status ----------

export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'overdue' | 'paid' | 'void';

export const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partial: 'Partially paid',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

/** The status a person cares about, worked out from the stored facts. */
export function invoiceStatus(inv: Pick<Invoice, 'lifecycle' | 'balance' | 'paid' | 'dueDate'> & { credited?: number }): InvoiceStatus {
  if (inv.lifecycle === 'void') return 'void';
  if (inv.lifecycle === 'draft') return 'draft';
  if (inv.balance <= 0) return 'paid';
  if (inv.dueDate < todayISO()) return 'overdue';
  return inv.paid > 0 || (inv.credited ?? 0) > 0 ? 'partial' : 'sent';
}

/** "Due in 5 days", "Due today", "12 days overdue". */
export function dueText(dueDate: string): string {
  const days = daysBetween(todayISO(), dueDate);
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days > 1) return `Due in ${days} days`;
  return `${-days} ${days === -1 ? 'day' : 'days'} overdue`;
}

// ---------- GST ----------

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Same check as the server: format plus the check digit. */
export function validGstin(value: string): boolean {
  const g = value.trim().toUpperCase();
  if (!GSTIN_PATTERN.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = GSTIN_CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return g[14] === GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

// Money math in whole paise, rounding half up exactly like the Go server,
// so the preview always matches what gets saved.
const hundredths = (n: unknown) => Math.round((Number(n) || 0) * 100);
const roundDiv = (a: number, b: number) => Math.floor((2 * a + b) / (2 * b));

export interface LineCalc {
  taxable: number;
  discount: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/** Prices one line in paise. */
export function calcLine(
  line: { quantity?: unknown; rate?: unknown; discountPct?: unknown; taxRate?: unknown },
  interState: boolean,
  gstRegistered: boolean,
): LineCalc {
  const gross = roundDiv(hundredths(line.quantity) * hundredths(line.rate), 100);
  const discount = roundDiv(gross * hundredths(line.discountPct), 10000);
  const taxable = gross - discount;
  const rate = gstRegistered ? hundredths(line.taxRate) : 0;
  if (interState) return { taxable, discount, cgst: 0, sgst: 0, igst: roundDiv(taxable * rate, 10000) };
  const half = roundDiv(taxable * rate, 20000);
  return { taxable, discount, cgst: half, sgst: half, igst: 0 };
}

// ---------- Amount in words (Indian numbering) ----------

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven',
  'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? ONES[h] + ' Hundred' : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/** 47790.5 → "Rupees Forty-Seven Thousand Seven Hundred Ninety and Fifty Paise Only" */
export function amountInWords(amount: number): string {
  const paise = Math.round(amount * 100);
  let rupees = Math.floor(paise / 100);
  const p = paise % 100;
  if (rupees === 0 && p === 0) return 'Rupees Zero Only';
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  rupees %= 10_000_000;
  const lakh = Math.floor(rupees / 100_000);
  rupees %= 100_000;
  const thousand = Math.floor(rupees / 1000);
  rupees %= 1000;
  if (crore) parts.push(belowThousand(crore) + ' Crore');
  if (lakh) parts.push(belowHundred(lakh) + ' Lakh');
  if (thousand) parts.push(belowHundred(thousand) + ' Thousand');
  if (rupees) parts.push(belowThousand(rupees));
  let words = parts.length ? 'Rupees ' + parts.join(' ') : 'Rupees Zero';
  if (p) words += ' and ' + belowHundred(p) + ' Paise';
  return words + ' Only';
}

// ---------- CSV export ----------

/** Downloads rows as a CSV file that opens cleanly in Excel. */
export function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const cell = (v: string | number) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const MODE_LABEL: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  cheque: 'Cheque',
  card: 'Card',
  other: 'Other',
};

export const GST_TREATMENT_LABEL: Record<string, string> = {
  registered: 'Registered business',
  unregistered: 'Unregistered business',
  consumer: 'Consumer',
  overseas: 'Overseas',
};

export const FREQUENCY_LABEL: Record<string, string> = {
  weekly: 'Every week',
  monthly: 'Every month',
  quarterly: 'Every 3 months',
  half_yearly: 'Every 6 months',
  yearly: 'Every year',
};

/** Turns a phone number into WhatsApp's format: country code + number, digits only. */
export function whatsappNumber(phone: string): string {
  let d = (phone || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  d = d.replace(/^0+/, '');
  return d.length === 10 ? '91' + d : d;
}

/** WhatsApp's free click-to-chat link; with no number, WhatsApp asks who to send to. */
export function whatsappLink(phone: string, text: string): string {
  const n = whatsappNumber(phone);
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}
