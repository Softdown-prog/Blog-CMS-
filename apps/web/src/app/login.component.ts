import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

@Component({
  selector: 'blog-login',
  standalone: true,
  imports: [RouterLink],
  template: `
    <section class="container login-page">
      <a routerLink="/">Voltar ao blog</a>
      <h1>Entrar no painel</h1>
      <p>Somente contas editoriais autorizadas.</p>
      <form class="panel login-form" (submit)="submit($event, email.value, password.value)">
        <label for="admin-email">E-mail</label>
        <input id="admin-email" type="email" #email autocomplete="username"
          required maxlength="254" inputmode="email"/>
        <label for="admin-password">Senha</label>
        <input id="admin-password" type="password" #password
          autocomplete="current-password" required maxlength="1024"/>
        <button type="submit" [disabled]="busy()">
          {{ busy() ? 'Verificando…' : 'Entrar' }}
        </button>
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
      </form>
    </section>
  `,
})
export class LoginComponent {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected submit(event: Event, email: string, password: string): void {
    event.preventDefault();
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    // Sem token em localStorage/sessionStorage. O backend emite cookie HttpOnly.
    this.http.post('/api/admin/login', { email, password }).subscribe({
      next: () => {
        this.busy.set(false);
        void this.router.navigateByUrl('/admin');
      },
      error: (failure: unknown) => {
        this.busy.set(false);
        this.error.set(failure instanceof HttpErrorResponse && failure.status === 429
          ? 'Muitas tentativas. Tente novamente mais tarde.'
          : failure instanceof HttpErrorResponse && failure.status === 503
            ? 'Autenticação temporariamente indisponível.'
            : 'Não foi possível entrar. Verifique suas credenciais.');
      },
    });
  }
}
