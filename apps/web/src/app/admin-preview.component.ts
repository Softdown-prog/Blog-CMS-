import { Component, computed, signal } from '@angular/core';
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

/**
 * Explicitly offline: this view is not an authenticated admin editor.
 * All values live in Angular memory only and are lost on refresh.
 */
@Component({
  selector: 'blog-admin-preview',
  standalone: true,
  templateUrl: './admin-preview.component.html',
  styleUrl: './admin-preview.component.css',
})
export class AdminPreviewComponent {
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

