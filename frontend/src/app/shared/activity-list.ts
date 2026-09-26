import { DatePipe } from '@angular/common';
import { Component, input } from '@angular/core';
import { ActivityEntry } from '../core/models';

const ICONS: Record<string, string> = {
  created: 'circle-plus', edited: 'pencil', emailed: 'mail', whatsapp: 'brand-whatsapp', email_app: 'mail-forward',
  sent: 'send', void: 'ban', invoiced: 'file-invoice', credited: 'receipt-refund', applied: 'receipt-refund',
  refunded: 'cash', accepted: 'circle-check', declined: 'circle-x', invoice_created: 'file-invoice', paused: 'player-pause',
  active: 'player-play', ended: 'flag',
};

@Component({
  selector: 'app-activity-list',
  imports: [DatePipe],
  template: `
    @if (entries().length) {
      <section class="card activity no-print">
        <h2>History</h2>
        <ol>
          @for (a of entries(); track $index) {
            <li>
              <i class="ti ti-{{ icon(a.action) }}" aria-hidden="true"></i>
              <span>{{ a.detail }}</span>
              <time class="muted">{{ a.createdAt.replace(' ', 'T') | date: 'd MMM, h:mm a' }}</time>
            </li>
          }
        </ol>
      </section>
    }
  `,
})
export class ActivityList {
  readonly entries = input<ActivityEntry[]>([]);
  protected icon(action: string) {
    return ICONS[action] ?? 'point';
  }
}
