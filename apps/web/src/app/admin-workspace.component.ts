import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AdminPreviewComponent } from './admin-preview.component';

interface SessionInfo {
  readonly user: Readonly<{ id: string; role: 'admin' | 'editor' | 'author' }>;
}

/** Sessão real; a bancada editorial abaixo continua offline e sem escrita. */
@Component({
  selector: 'blog-admin-workspace',
  standalone: true,
  imports: [AdminPreviewComponent, RouterLink],
  template: `
    <section class="container admin-session-bar">
      <div>
        <p class="eyebrow">SESSÃO ADMINISTRATIVA</p>
        @if (role()) {
          <p>Conectado como {{ role() }}.</p>
        } @else {
          <p>Verificando sessão…</p>
        }
      </div>
      @if (role() === 'admin') { <a routerLink="/admin/site">Páginas e widgets</a> }
      <button type="button" [disabled]="ending()" (click)="logout()">
        {{ ending() ? 'Saindo…' : 'Sair da conta' }}
      </button>
      @if (error()) { <p role="alert">{{ error() }}</p> }
    </section>
    <blog-admin-preview [canPublish]="role() === 'editor' || role() === 'admin'" />
  `,
})
export class AdminWorkspaceComponent {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly role = signal<string | null>(null);
  protected readonly ending = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.http.get<SessionInfo>('/api/admin/session').subscribe({
      next: value => this.role.set(value.user.role),
      error: () => { void this.router.navigateByUrl('/login'); },
    });
  }

  protected logout(): void {
    if (this.ending()) return;
    // Cookie CSRF é legível; cookie de sessão é HttpOnly e jamais lido pelo JS.
    const csrf = document.cookie.split(';').map(value => value.trim())
      .find(value => value.startsWith('cms_csrf='))?.slice('cms_csrf='.length);
    if (!csrf) {
      this.error.set('Não foi possível confirmar a sessão. Entre novamente.');
      return;
    }
    this.ending.set(true);
    this.error.set(null);
    this.http.post('/api/admin/logout', {}, {
      headers: { 'X-CMS-CSRF': csrf }, observe: 'response',
    }).subscribe({
      next: () => {
        this.ending.set(false);
        void this.router.navigateByUrl('/login');
      },
      error: () => {
        this.ending.set(false);
        this.error.set('Não foi possível encerrar a sessão. Tente novamente.');
      },
    });
  }
}
