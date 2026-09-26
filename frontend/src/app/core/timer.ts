import { Injectable, computed, inject, signal } from '@angular/core';
import { tap } from 'rxjs';
import { Api } from './api';
import { TimeEntry } from './models';

/** The running timer, shared by the top bar and the timesheet. It keeps running on the server between visits. */
@Injectable({ providedIn: 'root' })
export class Timer {
  private api = inject(Api);
  readonly running = signal<TimeEntry | null>(null);
  private readonly now = signal(Date.now());
  private startedAt = 0;
  readonly elapsed = computed(() => (this.running() ? Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)) : 0));

  constructor() {
    setInterval(() => {
      if (this.running()) this.now.set(Date.now());
    }, 1000);
  }

  private set(t: TimeEntry | null) {
    if (t) this.startedAt = Date.now() - t.elapsedSeconds * 1000;
    this.now.set(Date.now());
    this.running.set(t);
  }

  refresh() {
    this.api.timer().subscribe({ next: (t) => this.set(t), error: () => {} });
  }

  start(body: { projectId: number; task: string; billable: boolean }) {
    return this.api.startTimer(body).pipe(tap((t) => this.set(t)));
  }

  stop() {
    return this.api.stopTimer().pipe(tap(() => this.set(null)));
  }

  clear() {
    this.set(null);
  }
}

/** 3725 seconds → "1:02:05". */
export function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 95 minutes → "1h 35m". */
export function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "1:30", "1.5", "90m", or "1h 30m" → minutes (0 if it can't be read). */
export function parseDuration(text: string): number {
  const t = text.trim().toLowerCase();
  if (!t) return 0;
  let m = /^(\d+):([0-5]?\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(?:(\d+(?:\.\d+)?)\s*h(?:rs?|ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(t);
  if (m && (m[1] || m[2])) return Math.round(Number(m[1] || 0) * 60) + Number(m[2] || 0);
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60);
  return 0;
}
