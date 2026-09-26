import { Component, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { errorMessage } from '../../core/api';
import { Auth } from '../../core/auth';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule],
  template: `
    <div class="auth-card card">
      <div class="auth-brand"><span class="brand-mark" aria-hidden="true">A</span><span class="brand-name">Averqo</span></div>
      <h1>Sign in</h1>
      <p class="muted">Welcome back. Sign in to your business account.</p>
      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <label class="field"><span>Email</span><input type="email" formControlName="email" autocomplete="username" autofocus /></label>
        <label class="field"><span>Password</span><input type="password" formControlName="password" autocomplete="current-password" /></label>
        @if (error()) { <div class="alert" role="alert"><span>{{ error() }}</span></div> }
        <button type="submit" class="btn btn-primary btn-block" [disabled]="busy()">{{ busy() ? 'Signing in…' : 'Sign in' }}</button>
      </form>
      <p class="sub auth-foot">Forgot your password? Ask your account owner to set a new one in Settings, then Team.</p>
    </div>
  `,
})
export class Login {
  private auth = inject(Auth);
  private router = inject(Router);
  readonly next = input<string>(); // ?next= page to return to
  protected busy = signal(false);
  protected error = signal('');
  protected form = inject(NonNullableFormBuilder).group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  protected submit() {
    this.error.set('');
    if (this.form.invalid) {
      this.error.set('Enter your email and password.');
      return;
    }
    const { email, password } = this.form.getRawValue();
    this.busy.set(true);
    this.auth.login(email, password).subscribe({
      next: () => this.router.navigateByUrl(this.safeNext()),
      error: (e) => {
        this.error.set(errorMessage(e));
        this.busy.set(false);
      },
    });
  }

  /** Only return to pages inside the app, never to another website. */
  private safeNext() {
    const n = this.next() ?? '';
    return n.startsWith('/') && !n.startsWith('//') ? n : '/home';
  }
}
