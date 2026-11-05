import { Component, computed, signal } from '@angular/core';
import {
  WORKBENCH_BLOCK_LIMIT, createWorkbenchBlock, workbenchDocument,
} from '../../../api/src/editorial/editor-workbench';
import type { WorkbenchBlock, WorkbenchBlockKind } from '../../../api/src/editorial/editor-workbench';
import { reviewPublication } from '../../../api/src/editorial/publication-tools';
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

  protected addBlock(kind: WorkbenchBlockKind): void {
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
    }
  }

  protected blockLength(kind: WorkbenchBlockKind): number {
    switch (kind) {
      case 'heading': return 180;
      case 'paragraph': return 5000;
      case 'quote': return 2000;
      case 'list': return 14000;
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

