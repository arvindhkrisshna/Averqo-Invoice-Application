import { DocType, SalesDoc } from './models';
import { todayISO } from './format';

/** Everything that differs between quotes, delivery challans, and credit notes. */
export interface DocKind {
  type: DocType;
  path: string; // API and URL path
  route: string; // app route
  label: string; // "Quote"
  plural: string; // "Quotes"
  title: string; // printed heading
  numberLabel: string;
  dateLabel: string;
  issued: string; // status once issued: sent | open
  issueVerb: string; // button text
  icon: string;
  empty: string;
}

export const DOC_KINDS: Record<DocType, DocKind> = {
  quote: {
    type: 'quote', path: 'quotes', route: '/quotes', label: 'Quote', plural: 'Quotes', title: 'Quotation',
    numberLabel: 'Quote no.', dateLabel: 'Quote date', issued: 'sent', issueVerb: 'Save and mark as sent', icon: 'file-description',
    empty: 'Send a price estimate. When the customer agrees, turn it into an invoice in one click.',
  },
  challan: {
    type: 'challan', path: 'challans', route: '/delivery-challans', label: 'Delivery challan', plural: 'Delivery challans',
    title: 'Delivery challan', numberLabel: 'Challan no.', dateLabel: 'Challan date', issued: 'open', issueVerb: 'Save and issue',
    icon: 'truck-delivery', empty: 'Record goods you send before billing. Invoice one or several challans together later.',
  },
  credit_note: {
    type: 'credit_note', path: 'credit-notes', route: '/credit-notes', label: 'Credit note', plural: 'Credit notes',
    title: 'Credit note', numberLabel: 'Credit note no.', dateLabel: 'Credit note date', issued: 'open', issueVerb: 'Save and issue',
    icon: 'receipt-refund', empty: 'Correct an invoice for returns or discounts. Use the credit on invoices, or refund it.',
  },
};

export const kindFromPath = (path: string) => Object.values(DOC_KINDS).find((k) => k.path === path) ?? DOC_KINDS.quote;

/** The status people see, including ones worked out from dates and balances. */
export function docStatus(d: Pick<SalesDoc, 'type' | 'status' | 'expiryDate' | 'balance'>): string {
  if (d.type === 'quote' && d.status === 'sent' && d.expiryDate && d.expiryDate < todayISO()) return 'expired';
  if (d.type === 'credit_note' && d.status === 'open' && d.balance <= 0) return 'closed';
  return d.status;
}

export const DOC_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'draft' },
  sent: { label: 'Sent', tone: 'sent' },
  accepted: { label: 'Accepted', tone: 'paid' },
  declined: { label: 'Declined', tone: 'overdue' },
  expired: { label: 'Expired', tone: 'partial' },
  invoiced: { label: 'Invoiced', tone: 'invoiced' },
  open: { label: 'Open', tone: 'sent' },
  cancelled: { label: 'Cancelled', tone: 'void' },
  closed: { label: 'Used', tone: 'paid' },
  void: { label: 'Void', tone: 'void' },
};
