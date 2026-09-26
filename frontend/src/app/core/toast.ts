import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  text: string;
  tone: 'success' | 'error';
}

/** Short confirmations like "Invoice saved" in the corner of the screen. */
@Injectable({ providedIn: 'root' })
export class Toasts {
  readonly list = signal<Toast[]>([]);
  private next = 1;

  show(text: string, tone: Toast['tone'] = 'success') {
    const id = this.next++;
    this.list.update((l) => [...l, { id, text, tone }]);
    setTimeout(() => this.dismiss(id), tone === 'error' ? 6000 : 3500);
  }

  dismiss(id: number) {
    this.list.update((l) => l.filter((t) => t.id !== id));
  }
}
