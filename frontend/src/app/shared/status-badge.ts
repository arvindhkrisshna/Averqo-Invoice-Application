import { Component, computed, input } from '@angular/core';
import { STATUS_LABEL, invoiceStatus } from '../core/format';
import { Invoice } from '../core/models';

/** One consistent colour and label per invoice status, everywhere in the app. */
@Component({
  selector: 'app-status-badge',
  template: `<span class="badge" [attr.data-tone]="status()">{{ label() }}</span>`,
})
export class StatusBadge {
  readonly invoice = input.required<Pick<Invoice, 'lifecycle' | 'balance' | 'paid' | 'dueDate'>>();
  protected status = computed(() => invoiceStatus(this.invoice()));
  protected label = computed(() => STATUS_LABEL[this.status()]);
}
