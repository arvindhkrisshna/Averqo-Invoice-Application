import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, errorMessage } from '../core/api';
import { whatsappLink, whatsappNumber } from '../core/format';
import { EmailStatus } from '../core/models';
import { SendContext } from '../core/send-text';
import { Toasts } from '../core/toast';

/**
 * Send an invoice, quote, challan, or credit note:
 *  - Email with the PDF attached (through your own email account's SMTP), or
 *    your own email app when email sending isn't set up.
 *  - WhatsApp: opens a chat with the message ready. On phones, "Share PDF"
 *    sends the PDF file itself through the share menu.
 */
@Component({
  selector: 'app-send-dialog',
  imports: [FormsModule, RouterLink],
  template: `
    @let c = ctx();
    <div class="dialog-backdrop" (click)="closed.emit()">
      <div class="dialog dialog-wide send-dialog" role="dialog" aria-labelledby="send-title" (click)="$event.stopPropagation()">
        <div class="dialog-head">
          <h2 id="send-title">Send {{ c.label.toLowerCase() }} {{ c.number }}</h2>
          <button type="button" class="icon-btn" aria-label="Close" (click)="closed.emit()"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>

        <div class="tabs" role="tablist">
          <button type="button" role="tab" [attr.aria-selected]="tab() === 'email'" (click)="tab.set('email')"><i class="ti ti-mail" aria-hidden="true"></i>Email</button>
          <button type="button" role="tab" [attr.aria-selected]="tab() === 'whatsapp'" (click)="openWhatsAppTab()"><i class="ti ti-brand-whatsapp" aria-hidden="true"></i>WhatsApp</button>
        </div>

        @if (tab() === 'email') {
          @if (status() === null) {
            <p class="muted">Checking email settings…</p>
          } @else {
            <div class="form-grid">
              <label class="field span-2"><span>To</span><input type="text" [(ngModel)]="to" name="to" placeholder="customer@example.com" inputmode="email" /></label>
              @if (status()!.configured) {
                <label class="field span-2"><span>CC <small class="muted">(optional)</small></span><input type="text" [(ngModel)]="cc" name="cc" placeholder="you@yourbusiness.in" /></label>
              }
              <label class="field span-2"><span>Subject</span><input type="text" [(ngModel)]="subject" name="subject" /></label>
              <label class="field span-2"><span>Message</span><textarea rows="9" [(ngModel)]="message" name="message"></textarea></label>
            </div>
            @if (status()!.configured) {
              <p class="attach"><i class="ti ti-paperclip" aria-hidden="true"></i>{{ c.fileName }} will be attached · from {{ status()!.fromEmail }}</p>
            } @else {
              <div class="alert alert-info" role="status">
                <span>To send with the PDF attached straight from Averqo, <a routerLink="/settings" fragment="email" (click)="closed.emit()">set up email sending</a> (free with Gmail). For now, open your own email app and attach the PDF.</span>
              </div>
            }
            @if (error()) { <div class="alert" role="alert"><span>{{ error() }}</span></div> }
            <div class="form-actions">
              <a class="btn" [href]="pdfUrl(true)" [attr.download]="c.fileName"><i class="ti ti-download" aria-hidden="true"></i>Download PDF</a>
              @if (status()!.configured) {
                <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="sendEmail()"><i class="ti ti-send" aria-hidden="true"></i>{{ busy() ? 'Sending…' : 'Send email' }}</button>
              } @else {
                <a class="btn btn-primary" [href]="mailto()" (click)="openedEmailApp()"><i class="ti ti-mail-forward" aria-hidden="true"></i>Open in my email app</a>
              }
            </div>
          }
        } @else {
          <div class="form-grid">
            <label class="field span-2">
              <span>Customer's WhatsApp number</span>
              <input type="tel" [(ngModel)]="phone" name="phone" placeholder="98765 43210" />
              <small class="hint">{{ phone.trim() ? 'Sends to +' + waNumber() : 'Leave empty to choose the chat in WhatsApp.' }} Numbers without a country code are treated as Indian (+91).</small>
            </label>
            <label class="field span-2"><span>Message</span><textarea rows="9" [(ngModel)]="waText" name="waText"></textarea></label>
          </div>
          <p class="hint">
            @if (canSharePdf()) {
              "Share PDF" sends the PDF file itself. Pick WhatsApp in your phone's share menu.
            } @else {
              WhatsApp can't attach files from a link. Download the PDF, then attach it in the chat that opens.
            }
          </p>
          @if (error()) { <div class="alert" role="alert"><span>{{ error() }}</span></div> }
          <div class="form-actions">
            <a class="btn" [href]="pdfUrl(true)" [attr.download]="c.fileName"><i class="ti ti-download" aria-hidden="true"></i>Download PDF</a>
            @if (canSharePdf()) {
              <button type="button" class="btn" [disabled]="!pdfFile()" (click)="sharePdf()"><i class="ti ti-share" aria-hidden="true"></i>{{ pdfFile() ? 'Share PDF' : 'Preparing PDF…' }}</button>
            }
            <a class="btn btn-whatsapp" [href]="waLink()" target="_blank" rel="noopener" (click)="openedWhatsApp()"><i class="ti ti-brand-whatsapp" aria-hidden="true"></i>Open WhatsApp</a>
          </div>
        }
      </div>
    </div>
  `,
})
export class SendDialog<T = unknown> implements OnInit {
  readonly ctx = input.required<SendContext>();
  readonly startTab = input<'email' | 'whatsapp'>('email');
  readonly sent = output<T>();
  readonly closed = output<void>();

  private api = inject(Api);
  private toasts = inject(Toasts);

  protected tab = signal<'email' | 'whatsapp'>('email');
  protected status = signal<EmailStatus | null>(null);
  protected busy = signal(false);
  protected error = signal('');
  protected pdfFile = signal<File | null>(null);
  protected to = '';
  protected cc = '';
  protected subject = '';
  protected message = '';
  protected phone = '';
  protected waText = '';

  protected canSharePdf = computed(() => {
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (!nav.canShare) return false;
    try {
      return nav.canShare({ files: [new File(['x'], 'test.pdf', { type: 'application/pdf' })] });
    } catch {
      return false;
    }
  });

  ngOnInit() {
    const c = this.ctx();
    this.to = c.email;
    this.subject = c.subject;
    this.message = c.emailBody;
    this.phone = c.phone;
    this.waText = c.whatsappText;
    this.api.emailStatus().subscribe({
      next: (s) => this.status.set(s),
      error: () => this.status.set({ configured: false, fromEmail: '', fromName: '' }),
    });
    if (this.startTab() === 'whatsapp') this.openWhatsAppTab();
  }

  protected pdfUrl(download = false) {
    const c = this.ctx();
    return `/api/${c.path}/${c.id}/pdf${download ? '?download=1' : ''}`;
  }

  protected waNumber() {
    return whatsappNumber(this.phone);
  }

  protected waLink() {
    return whatsappLink(this.phone, this.waText);
  }

  protected mailto() {
    return `mailto:${encodeURIComponent(this.to.trim())}?subject=${encodeURIComponent(this.subject)}&body=${encodeURIComponent(this.message)}`;
  }

  protected openWhatsAppTab() {
    this.tab.set('whatsapp');
    this.error.set('');
    // Fetch the PDF ahead of time: phones only allow sharing right after a tap.
    if (this.canSharePdf() && !this.pdfFile()) {
      const c = this.ctx();
      this.api.pdfBlob(c.path, c.id).subscribe({
        next: (b) => this.pdfFile.set(new File([b], c.fileName, { type: 'application/pdf' })),
        error: (e) => this.error.set(errorMessage(e)),
      });
    }
  }

  protected sendEmail() {
    this.error.set('');
    this.busy.set(true);
    const c = this.ctx();
    this.api.emailDoc<T>(c.path, c.id, { to: this.to, cc: this.cc, subject: this.subject, message: this.message }).subscribe({
      next: (doc) => {
        this.toasts.show(`${c.number} emailed to ${this.to}`);
        this.sent.emit(doc);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.busy.set(false);
      },
    });
  }

  protected openedEmailApp() {
    this.record('email_app', this.to);
  }

  protected openedWhatsApp() {
    this.record('whatsapp', this.phone.trim() ? '+' + this.waNumber() : '');
  }

  protected async sharePdf() {
    const file = this.pdfFile();
    if (!file) return;
    try {
      await navigator.share({ files: [file], text: this.waText });
      this.record('whatsapp', this.phone.trim() ? '+' + this.waNumber() : '');
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') this.error.set("Couldn't open the share menu. Download the PDF instead.");
    }
  }

  /** You sent it yourself, so note it in the history and treat a draft as sent. */
  private record(channel: 'whatsapp' | 'email_app', to: string) {
    const c = this.ctx();
    this.api.markShared<T>(c.path, c.id, channel, to).subscribe({
      next: (doc) => {
        this.toasts.show(channel === 'whatsapp' ? `${c.number} shared on WhatsApp` : `${c.number} opened in your email app`);
        this.sent.emit(doc);
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }
}
