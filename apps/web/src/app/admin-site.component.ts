import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonGadgetAdminComponent } from './button-gadget-admin.component';
interface WidgetConfig {
 readonly key: 'latest-posts' | 'popular-posts' | 'page-links' | 'text' | 'buttons';
 readonly title: string; readonly enabled: boolean;
 readonly position: number; readonly content: string;
}
interface Draft { readonly id: string; readonly title: string; readonly kind: 'post' | 'page' }
@Component({
 selector: 'blog-admin-site', standalone: true, imports: [RouterLink, ButtonGadgetAdminComponent],
 template: `
 <section class="container">
   <a routerLink="/admin">Voltar ao painel</a>
   <h1>Páginas, postagens e widgets</h1>
   <p>Configure os blocos públicos do blog e classifique rascunhos como postagem ou página fixa.</p>
   <p class="admin-site-notice">Somente blocos nativos. HTML e scripts externos não são aceitos.</p>
   @if (error()) { <p role="alert" class="panel">{{ error() }}</p> }
   @if (feedback()) { <p role="status" class="panel">{{ feedback() }}</p> }
   <h2>Widgets e gadgets</h2>
   @for (entry of widgets(); track entry.key) {
     <section class="panel" [attr.data-widget-config]="entry.key">
       <h3>{{ entry.key === 'latest-posts' ? 'Últimas postagens' :
         entry.key === 'popular-posts' ? 'Mais populares' :
         entry.key === 'page-links' ? 'Páginas' :
         entry.key === 'buttons' ? 'Botões com hover e link' : 'Gadget de texto' }}</h3>
       <div class="widget-settings">
         <label>
           <span>Título</span>
           <input maxlength="80" [value]="entry.title" #title
             (input)="change(entry.key,'title',title.value)" />
         </label>
         <label>
           <span>Ordem (0–100)</span>
           <input type="number" min="0" max="100" [value]="entry.position" #position
             (change)="change(entry.key,'position',position.valueAsNumber)" />
         </label>
         <label class="full">
           <span><input type="checkbox" [checked]="entry.enabled" #enabled
             (change)="change(entry.key,'enabled',enabled.checked)" /> Exibir no site</span>
         </label>
         @if (entry.key === 'buttons') {
           <blog-button-gadget-admin />
         }
         @if (entry.key === 'text') {
           <label class="full">
             <span>Texto do gadget (sem HTML)</span>
             <textarea maxlength="1000" rows="4" [value]="entry.content" #body
               (input)="change(entry.key,'content',body.value)"></textarea>
           </label>
         }
       </div>
       <button type="button" [disabled]="busy()" (click)="save(entry)">Salvar widget</button>
     </section>
   }
   <h2>Separação do conteúdo</h2>
   <p>Rascunhos podem virar páginas fixas antes da publicação. Conteúdo publicado não pode ser reclassificado por este painel.</p>
   @for (draft of drafts(); track draft.id) {
     <div class="panel draft-kind-row">
       <strong>{{ draft.title }}</strong>
       <label>
         Tipo de conteúdo
         <select [value]="draft.kind" #kind
           (change)="setKind(draft.id,kind.value)">
           <option value="post">Postagem (feed)</option>
           <option value="page">Página fixa</option>
         </select>
       </label>
     </div>
   } @empty {
     <p>Não há rascunhos para classificar.</p>
   }
 </section>
 `,
})
export class AdminSiteComponent {
 private readonly http = inject(HttpClient);
 protected readonly widgets = signal<readonly WidgetConfig[]>([]);
 protected readonly drafts = signal<readonly Draft[]>([]);
 protected readonly busy = signal(false);
 protected readonly error = signal<string | null>(null);
 protected readonly feedback = signal<string | null>(null);
 constructor() {
   this.http.get<readonly WidgetConfig[]>('/api/admin/site/widgets').subscribe({
     next: value => this.widgets.set(value),
     error: () => this.error.set('Apenas administradores podem configurar o site.'),
   });
   this.http.get<readonly Draft[]>('/api/admin/site/drafts').subscribe({
     next: value => this.drafts.set(value),
     error: () => this.error.set('Não foi possível carregar os rascunhos.'),
   });
 }
 private csrf(): string | null {
   return document.cookie.split(';').map(v => v.trim())
     .find(v => v.startsWith('cms_csrf='))?.slice('cms_csrf='.length) ?? null;
 }
 protected change(key: WidgetConfig['key'], field: 'title' | 'enabled' | 'position' | 'content', value: string | boolean | number): void {
   this.widgets.update(current => current.map(entry =>
     entry.key === key ? { ...entry, [field]: value } as WidgetConfig : entry));
 }
 protected save(entry: WidgetConfig): void {
   const csrf = this.csrf();
   if (!csrf || this.busy()) { this.error.set('Sessão inválida ou operação em andamento.'); return; }
   this.error.set(null); this.feedback.set(null); this.busy.set(true);
   const { key, title, enabled, position, content } = entry;
   this.http.patch<WidgetConfig>('/api/admin/site/widgets/' + key,
     { title, enabled, position, content }, { headers: { 'X-CMS-CSRF': csrf } }).subscribe({
     next: value => {
       this.widgets.update(items => items.map(item => item.key === key ? value : item));
       this.feedback.set('Widget salvo.'); this.busy.set(false);
     },
     error: (reason: unknown) => {
       this.error.set(reason instanceof HttpErrorResponse && reason.status === 403
         ? 'Sem permissão para alterar widgets.'
         : 'Não foi possível salvar o widget.'); this.busy.set(false);
     },
   });
 }
 protected setKind(id: string, kind: string): void {
   const csrf = this.csrf();
   if (!csrf || this.busy() || (kind !== 'page' && kind !== 'post')) {
     this.error.set('Não foi possível alterar o tipo.'); return;
   }
   this.error.set(null); this.feedback.set(null); this.busy.set(true);
   this.http.patch<{ id: string; kind: 'post' | 'page' }>(
     '/api/admin/site/drafts/' + id + '/kind', { kind },
     { headers: { 'X-CMS-CSRF': csrf } },
   ).subscribe({
     next: value => {
       this.drafts.update(rows => rows.map(row => row.id === id ? { ...row, kind: value.kind } : row));
       this.feedback.set('Tipo de conteúdo atualizado.'); this.busy.set(false);
     },
     error: () => {
       this.error.set('Não foi possível alterar o rascunho. Recarregue a página.');
       this.busy.set(false);
     },
   });
 }
}
