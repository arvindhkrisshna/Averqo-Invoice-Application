import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, errorMessage } from '../../core/api';
import { Customer, Project } from '../../core/models';
import { Toasts } from '../../core/toast';

@Component({
  selector: 'app-project-form',
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <section class="page">
      <div class="page-head">
        <div>
          <a class="back" [routerLink]="existing() ? ['/time-tracking/projects', existing()!.id] : '/time-tracking/projects'"><i class="ti ti-arrow-left" aria-hidden="true"></i>{{ existing() ? existing()!.name : 'Projects' }}</a>
          <h1>{{ existing() ? 'Edit project' : 'New project' }}</h1>
        </div>
        @if (existing()) {
          <div class="head-actions"><button type="button" class="btn" (click)="remove()"><i class="ti ti-trash" aria-hidden="true"></i>Delete</button></div>
        }
      </div>
      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else {
        <form [formGroup]="form" (ngSubmit)="save()" novalidate>
          <div class="card form-card">
            <div class="form-grid">
              <label class="field span-2"><span>Project name</span><input type="text" formControlName="name" maxlength="120" placeholder="Website redesign" /></label>
              <label class="field span-2"><span>Customer</span>
                <select formControlName="customerId">
                  <option [ngValue]="null" disabled>Choose a customer</option>
                  @for (c of customerOptions(); track c.id) { <option [ngValue]="c.id">{{ c.displayName }}</option> }
                </select>
                @if (!customers().length) { <small class="hint">Add a customer first. <a routerLink="/customers/new">New customer</a></small> }
              </label>
              <label class="field"><span>Hourly rate (₹)</span><input type="number" formControlName="hourlyRate" min="0" step="0.01" />
                <small class="hint">Use 0 for work you don't bill by the hour.</small></label>
              <label class="field"><span>Budget hours <em class="sub">(optional)</em></span><input type="number" formControlName="budgetHours" min="0" step="0.25" /></label>
              <label class="field"><span>SAC code <em class="sub">(for the invoice)</em></span><input type="text" formControlName="sac" class="mono" maxlength="8" inputmode="numeric" placeholder="998314" /></label>
              <label class="field"><span>GST rate</span>
                <select formControlName="taxRate">@for (r of rates(); track r) { <option [ngValue]="r">{{ r }}%</option> }</select></label>
              <label class="field span-2"><span>Description <em class="sub">(optional)</em></span><textarea formControlName="description" rows="2" maxlength="1000"></textarea></label>
              @if (existing()) {
                <div class="field span-2"><span>Status</span>
                  <div class="segmented" role="radiogroup" aria-label="Status">
                    <label><input type="radio" formControlName="status" value="active" /> Active</label>
                    <label><input type="radio" formControlName="status" value="completed" /> Completed</label>
                  </div>
                  <small class="hint">Completed projects don't take new time, but their unbilled hours can still be invoiced.</small>
                </div>
              }
            </div>
          </div>
          @if (error()) { <div class="alert" role="alert"><span>{{ error() }}</span></div> }
          <div class="form-actions">
            <a class="btn" routerLink="/time-tracking/projects">Cancel</a>
            <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save project' }}</button>
          </div>
        </form>
      }
    </section>
  `,
})
export class ProjectForm implements OnInit {
  private api = inject(Api);
  private router = inject(Router);
  private toasts = inject(Toasts);
  private fb = inject(NonNullableFormBuilder);
  readonly id = input<string>();
  readonly customerId = input<string>();
  protected meta = toSignal(this.api.meta());
  protected rates = computed(() => this.meta()?.gstRates ?? [0, 5, 18, 40]);
  protected loading = signal(true);
  protected saving = signal(false);
  protected error = signal('');
  protected existing = signal<Project | null>(null);
  protected customers = signal<Customer[]>([]);
  protected customerOptions = computed(() => this.customers().filter((c) => !c.archived || c.id === this.existing()?.customerId));
  protected form = this.fb.group({
    name: [''],
    customerId: this.fb.control<number | null>(null),
    hourlyRate: [0],
    budgetHours: this.fb.control<number | null>(null),
    sac: [''],
    taxRate: [18],
    description: [''],
    status: this.fb.control<'active' | 'completed'>('active'),
  });

  ngOnInit() {
    this.api.customers().subscribe({
      next: (c) => {
        this.customers.set(c);
        const id = this.id();
        if (!id) {
          const cid = Number(this.customerId());
          if (cid) this.form.patchValue({ customerId: cid });
          this.loading.set(false);
          return;
        }
        this.api.project(id).subscribe({
          next: (p) => {
            this.existing.set(p);
            this.form.patchValue({ name: p.name, customerId: p.customerId, hourlyRate: p.hourlyRate, budgetHours: p.budgetHours,
              sac: p.sac, taxRate: p.taxRate, description: p.description, status: p.status });
            this.loading.set(false);
          },
          error: (e) => this.fail(e),
        });
      },
      error: (e) => this.fail(e),
    });
  }

  private fail(e: unknown) {
    this.error.set(errorMessage(e));
    this.loading.set(false);
  }

  protected save() {
    this.error.set('');
    const v = this.form.getRawValue();
    if (!v.name.trim()) return this.error.set('Give the project a name.');
    if (!v.customerId) return this.error.set('Choose the customer this project is for.');
    this.saving.set(true);
    const body = { name: v.name, customerId: v.customerId, hourlyRate: Number(v.hourlyRate) || 0, sac: v.sac.trim(),
      taxRate: Number(v.taxRate), budgetHours: v.budgetHours ? Number(v.budgetHours) : null, status: v.status, description: v.description };
    this.api.saveProject(body, this.existing()?.id).subscribe({
      next: (p) => {
        this.toasts.show(this.existing() ? 'Project updated' : 'Project created');
        this.router.navigate(['/time-tracking/projects', p.id]);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.saving.set(false);
      },
    });
  }

  protected remove() {
    const p = this.existing();
    if (!p || !confirm(`Delete ${p.name} and all its unbilled time? This can't be undone.`)) return;
    this.api.deleteProject(p.id).subscribe({
      next: () => {
        this.toasts.show('Project deleted');
        this.router.navigate(['/time-tracking/projects']);
      },
      error: (e) => this.toasts.show(errorMessage(e), 'error'),
    });
  }
}
