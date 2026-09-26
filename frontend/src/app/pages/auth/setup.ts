import { Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';

@Component({
  selector: 'app-setup',
  imports: [ReactiveFormsModule],
  template: `
    <div class="auth-card card">
      <div class="auth-brand"><img class="brand-mark" src="assets/averqo.png" alt="" /><span class="brand-name">Averqo</span></div>
      <h1>Create the owner account</h1>
      <p class="muted">This is a one-time step. The owner can add team members later and is the only one who can change business settings.</p>
      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <label class="field"><span>Your name</span><input type="text" formControlName="name" autocomplete="name" autofocus /></label>
        <label class="field"><span>Email</span><input type="email" formControlName="email" autocomplete="username" /></label>
        <label class="field"><span>Password</span><input type="password" formControlName="password" autocomplete="new-password" />
          <small class="hint">At least 8 characters. A short sentence is easy to remember and hard to guess.</small></label>
        <label class="field"><span>Type the password again</span><input type="password" formControlName="confirm" autocomplete="new-password" /></label>
        @if (codeRequired()) {
          <label class="field"><span>Setup code</span><input type="text" formControlName="setupCode" autocomplete="off" />
            <small class="hint">The SETUP_CODE value set on the server when it was installed.</small></label>
        }
        @if (error()) { <div class="alert" role="alert"><span>{{ error() }}</span></div> }
        <button type="submit" class="btn btn-primary btn-block" [disabled]="busy()">{{ busy() ? 'Creating…' : 'Create account and continue' }}</button>
      </form>
    </div>
  `,
})
export class Setup {
  private auth = inject(Auth);
  private router = inject(Router);
  protected busy = signal(false);
  protected error = signal('');
  protected codeRequired = computed(() => !!this.auth.status()?.setupCodeRequired);
  protected form = inject(NonNullableFormBuilder).group({
    name: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
    confirm: [''],
    setupCode: [''],
  });

  protected submit() {
    this.error.set('');
    const v = this.form.getRawValue();
    if (!v.name.trim() || this.form.controls.email.invalid) {
      this.error.set('Enter your name and a valid email address.');
      return;
    }
    if (v.password.length < 8) {
      this.error.set('Use a password of at least 8 characters.');
      return;
    }
    if (v.password !== v.confirm) {
      this.error.set("The two passwords don't match.");
      return;
    }
    this.busy.set(true);
    this.auth.setup({ name: v.name, email: v.email, password: v.password, setupCode: v.setupCode }).subscribe({
      next: () => this.router.navigate(['/getting-started']),
      error: (e) => {
        this.error.set(errorMessage(e));
        this.busy.set(false);
      },
    });
  }
}
