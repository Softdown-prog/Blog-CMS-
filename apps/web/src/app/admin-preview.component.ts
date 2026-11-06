import { Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { EditorialDocumentV1 } from '../../../api/src/editorial/document';
import {
  WORKBENCH_BLOCK_LIMIT, createWorkbenchBlock, createWorkbenchImageBlock, workbenchDocument,
} from '../../../api/src/editorial/editor-workbench';
import type { WorkbenchBlock, WorkbenchBlockKind } from '../../../api/src/editorial/editor-workbench';
import { reviewPublication } from '../../../api/src/editorial/publication-tools';
import {
  chooseFeaturedMedia, emptyFeaturedMedia, findMedia,
  sampleMediaCatalog, updateMediaAlt,
} from '../../../api/src/editorial/publication-media';
import type { FeaturedMediaV1, MediaAssetV1, MediaCatalogV1 } from '../../../api/src/editorial/publication-media';
import {
  addDraftTag, emptyDraftTaxonomy, parseDraftTaxonomy,
} from '../../../api/src/editorial/publication-taxonomy';
import type { DraftTaxonomyV1 } from '../../../api/src/editorial/publication-taxonomy';
import type { PublicationDiagnostic } from '../../../api/src/editorial/publication-tools';

interface DraftListItem {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly kind: 'post' | 'page';
  readonly revision: number;
  readonly updatedAt: string;
}
interface DraftCatalogPage {
  readonly items: readonly DraftListItem[];
  readonly nextPage: number | null;
}
interface PersistedDraft {
  readonly id: string;
  readonly kind: 'post' | 'page';
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string;
  readonly revision: number;
  readonly status: 'draft' | 'published';
  readonly body: EditorialDocumentV1;
}



interface HistoryRevision {
  readonly postId: string;
  readonly revision: number;
  readonly recordedAt: string;
  readonly origin: { readonly kind: 'user'; readonly userId: string }
    | { readonly kind: 'system'; readonly service: string };
  readonly snapshot: Omit<PersistedDraft, 'kind'>;
}
interface RevisionPage {
  readonly items: readonly HistoryRevision[];
  readonly nextBeforeRevision: number | null;
}

/**
 * Authenticated workbench: draft save/load/publish is explicit and revision-checked.
 * Media catalog, taxonomy and cover remain demonstrative until persisted.
 */
@Component({
  selector: 'blog-admin-preview',
  standalone: true,
  imports: [RouterLink, DatePipe],
  templateUrl: './admin-preview.component.html',
  styleUrl: './admin-preview.component.css',
})

export class AdminPreviewComponent {

  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly canPublish = input(false);
  protected readonly kind = signal<'post' | 'page'>('post');
  protected readonly draftId = signal<string | null>(null);
  protected readonly revision = signal<number | null>(null);
  protected readonly draftList = signal<readonly DraftListItem[]>([]);
  protected readonly showDrafts = signal(false);
  protected readonly draftQuery = signal('');
  protected readonly draftKindFilter = signal<'all' | 'post' | 'page'>('all');
  protected readonly draftAppliedQuery = signal('');
  protected readonly draftAppliedKind = signal<'all' | 'post' | 'page'>('all');
  protected readonly draftNextPage = signal<number | null>(null);
  protected readonly draftSearchError = signal<string | null>(null);
  protected readonly showHistory = signal(false);
  protected readonly historyEntries = signal<readonly HistoryRevision[]>([]);
  protected readonly historyCursor = signal<number | null>(null);
  protected readonly historySelection = signal<number | null>(null);
  protected readonly historyError = signal<string | null>(null);
  protected readonly selectedHistorical = computed(() =>
    this.historyEntries().find(entry => entry.revision === this.historySelection()) ?? null);
  protected readonly busy = signal(false);
  protected readonly published = signal(false);
  protected readonly saveMessage = signal<string | null>(null);
  protected readonly saveError = signal<string | null>(null);
  private readonly savedSignature = signal<string | null>(null);
  protected readonly unsaved = computed(() => this.savedSignature() !== this.signature());

  constructor() {
    const queryId = this.route.snapshot.queryParamMap.get('draft');
    if (queryId && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(queryId)) {
      this.loadDraft(queryId, true);
    }
  }

  private signature(): string {
    return JSON.stringify({
      title: this.title(), slug: this.slug(), excerpt: this.excerpt(),
      blocks: this.blocks(), kind: this.kind(),
    });
  }

  private csrf(): string | null {
    return document.cookie.split(';').map(entry => entry.trim())
      .find(entry => entry.startsWith('cms_csrf='))?.slice('cms_csrf='.length) ?? null;
  }

  protected changeKind(raw: string): void {
    if (this.draftId() !== null) return;
    if (raw === 'post' || raw === 'page') this.kind.set(raw);
  }

  protected newDraft(): void {
    if (this.unsaved() && !window.confirm('Descartar alterações não salvas e começar outro rascunho?')) return;
    this.draftId.set(null);
    this.revision.set(null);
    this.kind.set('post');
    this.title.set('');
    this.slug.set('');
    this.excerpt.set('');
    this.blocks.set([{ ...createWorkbenchBlock(1, 'paragraph'), text: '' }]);
    this.nextBlockId = 2;
    this.published.set(false);
    this.savedSignature.set(null);
    this.saveMessage.set(null);
    this.saveError.set(null);
    this.clearHistory();
    void this.router.navigate([], {
      relativeTo: this.route, queryParams: { draft: null },
      queryParamsHandling: 'merge', replaceUrl: true,
    });
  }

  protected changeDraftKind(value: string): void {
    if (value === 'all' || value === 'post' || value === 'page') {
      this.draftKindFilter.set(value);
    }
  }

  protected listDrafts(loadMore = false): void {
    if (this.busy()) return;
    const page = loadMore ? this.draftNextPage() : 1;
    if (page === null) return;
    // A pagination continuation always uses the last submitted search, even if
    // someone has already typed a new (not yet submitted) filter in the input.
    const q = loadMore ? this.draftAppliedQuery() : this.draftQuery().trim();
    const kind = loadMore ? this.draftAppliedKind() : this.draftKindFilter();
    this.busy.set(true);
    this.draftSearchError.set(null);
    this.showDrafts.set(true);
    const url = '/api/admin/editorial/drafts/catalog?page=' + page
      + '&kind=' + kind + '&q=' + encodeURIComponent(q);
    this.http.get<DraftCatalogPage>(url).subscribe({
      next: response => {
        if (loadMore) {
          const found = new Set(this.draftList().map(item => item.id));
          this.draftList.update(items => [
            ...items, ...response.items.filter(item => !found.has(item.id)),
          ]);
        } else {
          this.draftList.set(response.items);
          this.draftAppliedQuery.set(q);
          this.draftAppliedKind.set(kind);
        }
        this.draftNextPage.set(response.nextPage);
        this.busy.set(false);
      },
      error: () => {
        this.draftSearchError.set('Não foi possível pesquisar os rascunhos. Verifique sua sessão.');
        this.busy.set(false);
      },
    });
  }

  protected selectDraft(id: string): void {
    if (!id) return;
    this.loadDraft(id, false);
  }

  private loadDraft(id: string, fromLink: boolean): void {
    if (this.busy()) return;
    if (!fromLink && this.unsaved()
      && !window.confirm('Descartar alterações não salvas e carregar outro rascunho?')) return;
    this.busy.set(true);
    this.saveError.set(null);
    this.http.get<PersistedDraft>('/api/admin/editorial/drafts/' + encodeURIComponent(id)).subscribe({
      next: post => {
        const blocks: WorkbenchBlock[] = post.body.blocks.map((block, index): WorkbenchBlock => {
          const base = { id: index + 1, kind: block.type, level: 2 as const };
          if (block.type === 'list') return { ...base, text: block.items.join('\n') };
          if (block.type === 'image') return { ...base, text: block.alt, mediaId: block.mediaId };
          return { ...base, text: block.text, level: block.type === 'heading' ? block.level : 2 };
        });
        this.draftId.set(post.id);
        this.revision.set(post.revision);
        this.kind.set(post.kind);
        this.title.set(post.title);
        this.slug.set(post.slug);
        this.excerpt.set(post.excerpt);
        this.blocks.set(blocks);
        this.nextBlockId = blocks.length + 1;
        this.clearHistory();
        this.published.set(false);
        this.savedSignature.set(this.signature());
        this.saveMessage.set('Rascunho recuperado do banco.');
        this.busy.set(false);
        if (!fromLink) void this.router.navigate([], {
          relativeTo: this.route, queryParams: { draft: post.id },
          queryParamsHandling: 'merge', replaceUrl: true,
        });
      },
      error: () => {
        this.saveError.set('Rascunho indisponível ou sem permissão de acesso.');
        this.busy.set(false);
      },
    });
  }


  private clearHistory(): void {
    this.showHistory.set(false);
    this.historyEntries.set([]);
    this.historyCursor.set(null);
    this.historySelection.set(null);
    this.historyError.set(null);
  }

  protected loadHistory(loadMore = false): void {
    const id = this.draftId();
    if (!id || this.busy()) return;
    const cursor = loadMore ? this.historyCursor() : null;
    if (loadMore && cursor === null) return;
    this.busy.set(true);
    this.historyError.set(null);
    const suffix = cursor === null ? '?limit=10' : '?limit=10&beforeRevision=' + cursor;
    this.http.get<RevisionPage>('/api/admin/editorial/drafts/' + id + '/revisions' + suffix)
      .subscribe({
        next: page => {
          if (loadMore) {
            const seen = new Set(this.historyEntries().map(entry => entry.revision));
            this.historyEntries.update(current => [
              ...current, ...page.items.filter(entry => !seen.has(entry.revision)),
            ]);
          } else {
            this.historyEntries.set(page.items);
            this.historySelection.set(null);
          }
          this.historyCursor.set(page.nextBeforeRevision);
          this.showHistory.set(true);
          this.busy.set(false);
        },
        error: () => {
          this.historyError.set('Não foi possível carregar o histórico desta postagem.');
          this.busy.set(false);
        },
      });
  }

  protected selectHistory(raw: string): void {
    if (!/^(0|[1-9]\d*)$/.test(raw)) {
      this.historySelection.set(null);
      return;
    }
    const value = Number(raw);
    this.historySelection.set(this.historyEntries().some(entry => entry.revision === value)
      ? value : null);
  }

  protected historicalText(block: EditorialDocumentV1['blocks'][number]): string {
    if (block.type === 'image') return 'Imagem: ' + block.alt;
    if (block.type === 'list') return block.items.join(' · ');
    return block.text;
  }

  protected restoreHistorical(): void {
    const id = this.draftId();
    const target = this.selectedHistorical();
    const currentRevision = this.revision();
    if (!id || !target || currentRevision === null || this.busy() || this.published()) return;
    if (target.revision >= currentRevision) {
      this.historyError.set('Escolha uma revisão anterior à versão atual.');
      return;
    }
    if (this.unsaved()) {
      this.historyError.set('Salve as alterações atuais antes de recuperar uma versão antiga.');
      return;
    }
    const csrf = this.csrf();
    if (!csrf) {
      this.historyError.set('Sessão inválida; entre novamente antes de restaurar.');
      return;
    }
    if (!window.confirm('Recuperar a revisão ' + target.revision
      + '? Será criada uma nova revisão e as anteriores serão preservadas.')) return;

    this.busy.set(true);
    this.historyError.set(null);
    this.saveError.set(null);
    this.saveMessage.set(null);
    this.http.post<PersistedDraft>('/api/admin/editorial/drafts/' + id + '/restore',
      { targetRevision: target.revision, expectedRevision: currentRevision },
      { headers: { 'X-CMS-CSRF': csrf } }).subscribe({
      next: post => {
        const blocks = post.body.blocks.map((block, index): WorkbenchBlock => {
          const base = { id: index + 1, kind: block.type, level: 2 as const };
          if (block.type === 'list') return { ...base, text: block.items.join('\n') };
          if (block.type === 'image') return { ...base, text: block.alt, mediaId: block.mediaId };
          return { ...base, text: block.text, level: block.type === 'heading' ? block.level : 2 };
        });
        this.kind.set(post.kind);
        this.title.set(post.title);
        this.slug.set(post.slug);
        this.excerpt.set(post.excerpt);
        this.blocks.set(blocks);
        this.nextBlockId = blocks.length + 1;
        this.revision.set(post.revision);
        this.savedSignature.set(this.signature());
        this.clearHistory();
        this.busy.set(false);
        this.saveMessage.set('Revisão ' + target.revision + ' recuperada como nova revisão '
          + post.revision + '. O histórico anterior foi preservado.');
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.historyError.set(error instanceof HttpErrorResponse && error.status === 409
          ? 'O rascunho foi modificado ou o endereço está ocupado. Reabra o texto antes de restaurar.'
          : error instanceof HttpErrorResponse && error.status === 404
            ? 'A revisão não existe ou não está acessível.'
            : 'Não foi possível recuperar a revisão. O texto atual continua na tela.');
      },
    });
  }

  protected saveDraft(): void {
    if (this.busy() || this.published()) return;
    let body: EditorialDocumentV1;
    try {
      body = workbenchDocument(this.blocks());
    } catch {
      this.saveError.set('Revise os blocos inválidos antes de salvar.');
      return;
    }
    if (body.blocks.some(block => block.type === 'image')) {
      this.saveError.set('Imagens de demonstração ainda não podem ser persistidas. Remova-as antes de salvar.');
      return;
    }
    const csrf = this.csrf();
    if (!csrf) {
      this.saveError.set('Sessão sem token CSRF. Entre novamente para salvar.');
      return;
    }
    const payload = { title: this.title(), slug: this.slug(),
      excerpt: this.excerpt(), body };
    const signature = this.signature();
    const id = this.draftId();
    const revision = this.revision();
    if (id && revision === null) return;
    this.saveError.set(null);
    this.saveMessage.set(null);
    this.busy.set(true);
    const response = id && revision !== null
      ? this.http.patch<PersistedDraft>('/api/admin/editorial/drafts/' + id,
        { ...payload, expectedRevision: revision }, { headers: { 'X-CMS-CSRF': csrf } })
      : this.http.post<PersistedDraft>('/api/admin/editorial/drafts',
        { ...payload, kind: this.kind() }, { headers: { 'X-CMS-CSRF': csrf } });
    response.subscribe({
      next: post => {
        this.draftId.set(post.id);
        this.revision.set(post.revision);
        this.kind.set(post.kind);
        this.savedSignature.set(signature);
        this.saveMessage.set('Rascunho salvo no PostgreSQL (revisão ' + post.revision + ').');
        this.busy.set(false);
        void this.router.navigate([], {
          relativeTo: this.route, queryParams: { draft: post.id },
          queryParamsHandling: 'merge', replaceUrl: true,
        });
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.saveError.set(error instanceof HttpErrorResponse && error.status === 409
          ? 'Conflito de revisão ou endereço repetido. Reabra o rascunho antes de salvar.'
          : error instanceof HttpErrorResponse && error.status === 403
            ? 'Permissão ou proteção CSRF negou o salvamento.'
            : 'Não foi possível salvar. O conteúdo local permanece na tela.');
      },
    });
  }

  protected publishDraft(): void {
    const id = this.draftId();
    const revision = this.revision();
    if (!this.canPublish() || !id || revision === null || this.busy() || this.published()) return;
    if (this.unsaved()) {
      this.saveError.set('Salve as alterações antes de publicar.');
      return;
    }
    const csrf = this.csrf();
    if (!csrf) {
      this.saveError.set('Sessão sem token CSRF. Entre novamente para publicar.');
      return;
    }
    this.busy.set(true);
    this.saveError.set(null);
    this.saveMessage.set(null);
    this.http.post<PersistedDraft>('/api/admin/editorial/drafts/' + id + '/publish',
      { expectedRevision: revision }, { headers: { 'X-CMS-CSRF': csrf } }).subscribe({
      next: post => {
        this.revision.set(post.revision);
        this.published.set(true);
        this.busy.set(false);
        this.saveMessage.set('Publicado. O conteúdo está disponível na área pública.');
        void this.router.navigate([], {
          relativeTo: this.route, queryParams: { draft: null },
          queryParamsHandling: 'merge', replaceUrl: true,
        });
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.saveError.set(error instanceof HttpErrorResponse && error.status === 409
          ? 'Versão desatualizada. Reabra o rascunho e tente novamente.'
          : error instanceof HttpErrorResponse && error.status === 422
            ? 'O conteúdo ainda não atende às regras de publicação.'
            : 'Não foi possível publicar. O rascunho permanece salvo.');
      },
    });
  }

  protected readonly title = signal('Meu primeiro artigo');
  protected readonly slug = signal('meu-primeiro-artigo');
  protected readonly excerpt = signal('');
  protected readonly blocks = signal<readonly WorkbenchBlock[]>([
    { ...createWorkbenchBlock(1, 'heading'), text: 'Por onde começar' },
    { ...createWorkbenchBlock(2, 'paragraph'),
      text: 'Escreva seu artigo aqui. A análise mostrará sugestões de título, resumo e estrutura.' },
  ]);
  protected readonly showPreview = signal(true);
  protected readonly previewSize = signal<'mobile' | 'desktop'>('mobile');
  protected readonly showHelp = signal(false);
  protected readonly categoryOptions: readonly string[] =
    ['Tecnologia', 'Tutoriais', 'Notícias', 'Projetos'];
  protected readonly taxonomy = signal<DraftTaxonomyV1>(emptyDraftTaxonomy());
  protected readonly tagDraft = signal('');
  protected readonly tagFeedback = signal<string | null>(null);
  protected readonly mediaCatalog = signal<MediaCatalogV1>(sampleMediaCatalog());
  protected readonly featuredMedia = signal<FeaturedMediaV1>(emptyFeaturedMedia());
  protected readonly mediaFeedback = signal<string | null>(null);
  protected readonly featuredAsset = computed(() =>
    findMedia(this.mediaCatalog(), this.featuredMedia().mediaId));
  private nextBlockId = 3;

  protected readonly review = computed(() => {
    let body: unknown;
    try {
      body = workbenchDocument(this.blocks());
    } catch {
      // The canonical parser rejects malformed content. Keep the editor
      // responsive, but report invalid-document instead of silently repairing.
      body = null;
    }
    return reviewPublication({
      title: this.title(), slug: this.slug(), excerpt: this.excerpt(), body,
    });
  });

  protected readonly canAddBlock = computed(() => this.blocks().length < WORKBENCH_BLOCK_LIMIT);

  protected addBlock(kind: Exclude<WorkbenchBlockKind, 'image'>): void {
    if (!this.canAddBlock()) return;
    const block = createWorkbenchBlock(this.nextBlockId++, kind);
    this.blocks.update(current => [...current, block]);
  }

  protected removeBlock(id: number): void {
    this.blocks.update(current => current.filter(block => block.id !== id));
  }

  protected changeBlock(id: number, value: string): void {
    this.blocks.update(current => current.map(block => block.id === id
      ? { ...block, text: value } : block));
  }

  protected changeHeadingLevel(id: number, value: string): void {
    this.blocks.update(current => current.map(block =>
      block.id === id && block.kind === 'heading'
        ? { ...block, level: value === '3' ? 3 : 2 } : block));
  }

  protected changeCategory(value: string): void {
    try {
      this.taxonomy.set(parseDraftTaxonomy({
        ...this.taxonomy(), category: value === '' ? null : value,
      }));
      this.tagFeedback.set(null);
    } catch {
      this.tagFeedback.set('Categoria inválida. Selecione uma das opções.');
    }
  }

  protected addTag(): void {
    const result = addDraftTag(this.taxonomy(), this.tagDraft());
    if (result.ok) {
      this.taxonomy.set(result.value);
      this.tagDraft.set('');
      this.tagFeedback.set(null);
      return;
    }
    const feedback = {
      'invalid-input': 'Há um erro nos marcadores atuais.',
      'invalid-category': 'Categoria inválida.',
      'invalid-tag': 'Digite um marcador válido com até 40 caracteres.',
      'duplicate-tag': 'Este marcador já foi adicionado.',
      'too-many-tags': 'O limite é de 12 marcadores.',
    } as const;
    this.tagFeedback.set(feedback[result.error]);
  }

  protected removeTag(index: number): void {
    const next = this.taxonomy().tags.filter((_, current) => current !== index);
    this.taxonomy.set(parseDraftTaxonomy({ ...this.taxonomy(), tags: next }));
    this.tagFeedback.set(null);
  }

  protected changeMediaAlt(id: string, value: string): void {
    const result = updateMediaAlt(this.mediaCatalog(), id, value);
    if (!result.ok) {
      this.mediaFeedback.set('Descrição inválida; máximo de 180 caracteres.');
      return;
    }
    this.mediaCatalog.set(result.value);
    if (this.featuredMedia().mediaId === id && !value.trim()) {
      this.featuredMedia.set(emptyFeaturedMedia());
    }
    this.mediaFeedback.set(null);
  }

  protected chooseCover(id: string | null): void {
    const result = chooseFeaturedMedia(this.mediaCatalog(), id);
    if (!result.ok) {
      this.mediaFeedback.set('Selecione uma imagem com descrição alternativa.');
      return;
    }
    this.featuredMedia.set(result.value);
    this.mediaFeedback.set(null);
  }

  protected insertMediaInArticle(asset: MediaAssetV1): void {
    if (!this.canAddBlock()) return;
    try {
      const block = createWorkbenchImageBlock(this.nextBlockId++, asset);
      this.blocks.update(current => [...current, block]);
      this.mediaFeedback.set(null);
    } catch {
      this.mediaFeedback.set('Antes de inserir a imagem, informe sua descrição.');
    }
  }

  protected mediaDimensions(asset: MediaAssetV1): string {
    return asset.width + ' × ' + asset.height + ' · ' + asset.mimeType;
  }

  protected applySuggestedSlug(): void {
    const suggestion = this.review().suggestedSlug;
    if (suggestion) this.slug.set(suggestion);
  }

  protected applySuggestedExcerpt(): void {
    const suggestion = this.review().suggestedExcerpt;
    if (suggestion) this.excerpt.set(suggestion);
  }

  protected blockName(kind: WorkbenchBlockKind): string {
    switch (kind) {
      case 'heading': return 'Título de seção';
      case 'paragraph': return 'Parágrafo';
      case 'quote': return 'Citação';
      case 'list': return 'Lista';
      case 'image': return 'Imagem';
    }
  }

  protected blockLength(kind: WorkbenchBlockKind): number {
    switch (kind) {
      case 'heading': return 180;
      case 'paragraph': return 5000;
      case 'quote': return 2000;
      case 'list': return 14000;
      case 'image': return 180;
    }
  }

  protected listItems(text: string): string[] {
    return text.split(/\r?\n/u).filter(item => item.trim().length > 0);
  }

  protected noticeText(code: PublicationDiagnostic): string {
    const messages: Record<PublicationDiagnostic, string> = {
      'invalid-document': 'Existe um bloco inválido. Revise os limites e as linhas da lista.',
      'missing-title': 'Adicione um título válido.',
      'invalid-slug': 'O endereço precisa usar letras minúsculas, números e hífens.',
      'empty-body': 'O artigo ainda está sem conteúdo.',
      'missing-excerpt': 'Inclua uma descrição para apresentar o artigo.',
      'long-title': 'Considere um título com até 60 caracteres.',
      'long-excerpt': 'Considere uma descrição com até 160 caracteres.',
      'missing-heading': 'Considere dividir o texto com subtítulos.',
      'missing-image-alt': 'Descreva a imagem com um texto alternativo.',
      'short-article': 'O artigo está curto; avalie se falta alguma informação.',
    };
    return messages[code];
  }
}

