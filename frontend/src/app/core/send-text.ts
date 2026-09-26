import { DocKind } from './kinds';
import { Invoice, Organization, SalesDoc } from './models';

/** What the Send dialog needs: where to send, and ready-to-edit messages. */
export interface SendContext {
  path: string; // invoices | quotes | challans | credit-notes
  id: number;
  label: string; // "Invoice"
  number: string;
  customerName: string;
  email: string;
  phone: string;
  fileName: string;
  subject: string;
  emailBody: string;
  whatsappText: string;
}

const inr = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(n);
const date = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function payLines(org: Organization | null): string[] {
  if (!org) return [];
  const out: string[] = [];
  if (org.upiId) out.push(`UPI: ${org.upiId}`);
  if (org.bankAccountNumber) out.push(`Bank: ${[org.bankName, 'A/c ' + org.bankAccountNumber, org.bankIfsc && 'IFSC ' + org.bankIfsc].filter((x) => !!x).join(', ')}`);
  return out;
}

export function invoiceSendContext(inv: Invoice, org: Organization | null, phone: string): SendContext {
  const biz = org?.name || 'us';
  const owed = inv.lifecycle === 'sent' || inv.lifecycle === 'draft' ? inv.balance : 0;
  const pay = payLines(org);
  const email = [
    `Dear ${inv.customerName},`,
    '',
    `Please find attached invoice ${inv.invoiceNumber} dated ${date(inv.issueDate)} for ${inr(inv.total)}.`,
    owed > 0 ? `Amount due: ${inr(owed)}, by ${date(inv.dueDate)}.` : 'This invoice is fully paid. Thank you!',
    ...(owed > 0 && pay.length ? ['', 'You can pay by:', ...pay] : []),
    '',
    'Thank you for your business.',
    '',
    biz,
  ].join('\n');
  const wa = [
    `Hello ${inv.customerName},`,
    '',
    `Here is invoice *${inv.invoiceNumber}* from ${biz} for *${inr(inv.total)}*.`,
    owed > 0 ? `Amount due: *${inr(owed)}* by ${date(inv.dueDate)}.` : 'It is fully paid. Thank you!',
    ...(owed > 0 && pay.length ? ['', ...pay] : []),
    '',
    'Thank you!',
  ].join('\n');
  return {
    path: 'invoices', id: inv.id, label: 'Invoice', number: inv.invoiceNumber, customerName: inv.customerName,
    email: inv.customerEmail, phone, fileName: inv.invoiceNumber + '.pdf',
    subject: `Invoice ${inv.invoiceNumber} from ${biz}`, emailBody: email, whatsappText: wa,
  };
}

export function docSendContext(d: SalesDoc, kind: DocKind, org: Organization | null, phone: string): SendContext {
  const biz = org?.name || 'us';
  let body: string;
  let wa: string;
  switch (d.type) {
    case 'quote':
      body = `Please find attached our quotation ${d.number} for ${inr(d.total)}${d.expiryDate ? `, valid until ${date(d.expiryDate)}` : ''}.\n\nLet us know if you'd like to go ahead, or if you have any questions.`;
      wa = `Here is quotation *${d.number}* from ${biz} for *${inr(d.total)}*${d.expiryDate ? `, valid until ${date(d.expiryDate)}` : ''}.\n\nLet us know if you'd like to go ahead.`;
      break;
    case 'challan':
      body = `Please find attached delivery challan ${d.number} dated ${date(d.issueDate)} for the goods sent to you.`;
      wa = `Here is delivery challan *${d.number}* dated ${date(d.issueDate)} for the goods sent to you.`;
      break;
    default:
      body = `Please find attached credit note ${d.number} for ${inr(d.total)}${d.invoiceNumber ? ` against invoice ${d.invoiceNumber}` : ''}.`;
      wa = `Here is credit note *${d.number}* for *${inr(d.total)}*${d.invoiceNumber ? ` against invoice ${d.invoiceNumber}` : ''}.`;
  }
  return {
    path: kind.path, id: d.id, label: kind.label, number: d.number, customerName: d.customerName, email: d.customerEmail,
    phone, fileName: d.number + '.pdf', subject: `${kind.title} ${d.number} from ${biz}`,
    emailBody: `Dear ${d.customerName},\n\n${body}\n\nThank you,\n${biz}`,
    whatsappText: `Hello ${d.customerName},\n\n${wa}\n\nThank you!`,
  };
}
