import { Component, signal } from '@angular/core';

@Component({
  selector: 'blog-admin-preview',
  standalone: true,
  template: `
    <section class="container">
      <p class="eyebrow">ADMINISTRAÇÃO · PRÉVIA</p>
      <h1>Painel de escrita</h1>
      <p>O editor real e o login serão implementados na próxima fase.</p>
      <section class="panel">
        <h2>Próximas funcionalidades</h2>
        <p>Rascunhos, mídias, categorias, revisões e publicações.</p>
        <button type="button" data-testid="admin-help"
          (click)="showHelp.set(!showHelp())">Orientações do painel</button>
        @if (showHelp()) {
          <p data-testid="admin-help-text">Nenhuma postagem pode ser gravada nesta versão.</p>
        }
      </section>
    </section>
  `,
})
export class AdminPreviewComponent {
  protected readonly showHelp = signal(false);
}

