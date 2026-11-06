import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';

interface GadgetButton {
  readonly id: string;
  readonly label: string;
  readonly hoverText: string;
  readonly href: string;
  readonly position: number;
  readonly enabled: boolean;
}
type ButtonValues = Omit<GadgetButton, 'id'>;
const emptyButton = (): ButtonValues => ({
  label: '', hoverText: '', href: '', position: 50, enabled: true,
});
function ordered(rows: readonly GadgetButton[]): readonly GadgetButton[] {
  return [...rows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

@Component({
  selector: 'blog-button-gadget-admin',
  standalone: true,
  template: `
    <section class="button-gadget-admin" aria-label="Gerenciar botões com hover">
      <p>Adicione até 12 botões. Cada um tem texto, dica ao passar o mouse e link.
        Os botões ficam visíveis quando o widget estiver ativado e houver links habilitados.</p>
      @if (error()) { <p role="alert" data-testid="button-gadget-error">{{ error() }}</p> }
      @if (feedback()) { <p role="status" data-testid="button-gadget-status">{{ feedback() }}</p> }
      <div class="widget-button-editor" data-testid="new-button-form">
        <h4>Novo botão</h4>
        <div class="button-editor-grid">
          <label>Texto do botão
            <input maxlength="80" data-testid="new-button-label" [value]="draft().label" #label
              (input)="changeDraft('label', label.value)" />
          </label>
          <label>Texto de hover (dica)
            <input maxlength="160" data-testid="new-button-hover" [value]="draft().hoverText" #hover
              (input)="changeDraft('hoverText', hover.value)" />
          </label>
          <label>Link interno ou externo
            <input maxlength="500" data-testid="new-button-href" [value]="draft().href"
              placeholder="/pages/ajuda ou https://example.com" #href
              (input)="changeDraft('href', href.value)" />
          </label>
          <label>Posição (0–100)
            <input type="number" min="0" max="100" data-testid="new-button-position"
              [value]="draft().position" #position
              (change)="changeDraft('position', position.valueAsNumber)" />
          </label>
        </div>
        <label><span><input type="checkbox" [checked]="draft().enabled" #enabled
          (change)="changeDraft('enabled', enabled.checked)" /> Ativo</span></label>
        <button type="button" data-testid="add-gadget-button"
          [disabled]="busy() || buttons().length >= 12" (click)="create()">
          Adicionar botão
        </button>
      </div>
      <h4>Botões cadastrados ({{ buttons().length }}/12)</h4>
      @for (button of buttons(); track button.id) {
        <div class="widget-button-editor" [attr.data-button-id]="button.id">
          <div class="button-editor-grid">
            <label>Texto
              <input maxlength="80" [value]="button.label" #itemLabel
                (input)="changeButton(button.id,'label',itemLabel.value)" />
            </label>
            <label>Hover
              <input maxlength="160" [value]="button.hoverText" #itemHover
                (input)="changeButton(button.id,'hoverText',itemHover.value)" />
            </label>
            <label>Link
              <input maxlength="500" [value]="button.href" #itemHref
                (input)="changeButton(button.id,'href',itemHref.value)" />
            </label>
            <label>Posição
              <input type="number" min="0" max="100" [value]="button.position" #itemPosition
                (change)="changeButton(button.id,'position',itemPosition.valueAsNumber)" />
            </label>
          </div>
          <label><span><input type="checkbox" [checked]="button.enabled" #itemEnabled
            (change)="changeButton(button.id,'enabled',itemEnabled.checked)" /> Ativo</span></label>
          <div class="button-editor-actions">
            <button type="button" [disabled]="busy()" (click)="save(button)">Salvar botão</button>
            <button type="button" [disabled]="busy()" (click)="remove(button)">Excluir botão</button>
          </div>
        </div>
      } @empty {
        <p>Nenhum botão cadastrado. Adicione um acima para começar.</p>
      }
    </section>
  `,
})
export class ButtonGadgetAdminComponent {
  private readonly http = inject(HttpClient);
  protected readonly buttons = signal<readonly GadgetButton[]>([]);
  protected readonly draft = signal<ButtonValues>(emptyButton());
  protected readonly error = signal<string | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly busy = signal(false);
  constructor() {
    this.http.get<readonly GadgetButton[]>('/api/admin/site/buttons').subscribe({
      next: buttons => this.buttons.set(ordered(buttons)),
      error: () => this.error.set('Não foi possível carregar os botões.'),
    });
  }

  private csrf(): string | null {
    return document.cookie.split(';').map(v => v.trim())
      .find(v => v.startsWith('cms_csrf='))?.slice('cms_csrf='.length) ?? null;
  }
  private headers(): { readonly 'X-CMS-CSRF': string } | null {
    const csrf = this.csrf();
    return csrf ? { 'X-CMS-CSRF': csrf } : null;
  }
  private failed(err: unknown): void {
    this.error.set(err instanceof HttpErrorResponse && err.status === 409
      ? 'Limite de 12 botões atingido.'
      : err instanceof HttpErrorResponse && err.status === 400
        ? 'Confira texto, hover e link. Apenas HTTP, HTTPS ou caminhos internos são permitidos.'
        : 'Não foi possível gravar. Verifique a sessão e tente novamente.');
    this.busy.set(false);
  }
  protected changeDraft<K extends keyof ButtonValues>(field: K, value: ButtonValues[K]): void {
    this.draft.update(current => ({ ...current, [field]: value }));
  }
  protected changeButton<K extends keyof ButtonValues>(id: string, field: K, value: ButtonValues[K]): void {
    this.buttons.update(items => items.map(item =>
      item.id === id ? { ...item, [field]: value } : item));
  }
  protected create(): void {
    const headers = this.headers();
    if (!headers || this.busy()) { this.error.set('Sessão inválida.'); return; }
    this.error.set(null); this.feedback.set(null); this.busy.set(true);
    this.http.post<GadgetButton>('/api/admin/site/buttons', this.draft(), { headers }).subscribe({
      next: value => {
        this.buttons.update(items => ordered([...items, value]));
        this.draft.set(emptyButton());
        this.feedback.set('Botão adicionado.'); this.busy.set(false);
      },
      error: err => this.failed(err),
    });
  }
  protected save(item: GadgetButton): void {
    const headers = this.headers();
    if (!headers || this.busy()) { this.error.set('Sessão inválida.'); return; }
    this.error.set(null); this.feedback.set(null); this.busy.set(true);
    const { label, hoverText, href, position, enabled } = item;
    this.http.patch<GadgetButton>('/api/admin/site/buttons/' + item.id,
      { label, hoverText, href, position, enabled }, { headers }).subscribe({
      next: updated => {
        this.buttons.update(items => ordered(items.map(row => row.id === item.id ? updated : row)));
        this.feedback.set('Botão salvo.'); this.busy.set(false);
      },
      error: err => this.failed(err),
    });
  }
  protected remove(item: GadgetButton): void {
    if (this.busy() || !window.confirm('Excluir o botão "' + item.label + '"?')) return;
    const headers = this.headers();
    if (!headers) { this.error.set('Sessão inválida.'); return; }
    this.error.set(null); this.feedback.set(null); this.busy.set(true);
    this.http.delete<void>('/api/admin/site/buttons/' + item.id, { headers }).subscribe({
      next: () => {
        this.buttons.update(items => items.filter(row => row.id !== item.id));
        this.feedback.set('Botão excluído.'); this.busy.set(false);
      },
      error: err => this.failed(err),
    });
  }
}
