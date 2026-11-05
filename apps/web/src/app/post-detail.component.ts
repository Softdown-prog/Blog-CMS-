import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, distinctUntilChanged, map, of, startWith, switchMap } from 'rxjs';

type ArticleBlock =
  | Readonly<{ type: 'paragraph'; text: string }>
  | Readonly<{ type: 'heading'; level: 2 | 3; text: string }>
  | Readonly<{ type: 'quote'; text: string }>
  | Readonly<{ type: 'list'; items: readonly string[] }>
  | Readonly<{ type: 'image'; mediaId: string; alt: string }>;

interface PublicArticle {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly publishedAt: string;
  readonly body: Readonly<{ schemaVersion: 1; blocks: readonly ArticleBlock[] }>;
}

type ArticleState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'not-found' }>
  | Readonly<{ status: 'error' }>
  | Readonly<{ status: 'ready'; post: PublicArticle }>;

@Component({
  selector: 'blog-post-detail',
  standalone: true,
  imports: [RouterLink, DatePipe],
  template: `
    <section class="container">
      <a routerLink="/" class="back-link">Voltar ao blog</a>
      @if (state(); as current) {
        @if (current.status === 'loading') {
          <p class="panel" aria-live="polite">Carregando artigo…</p>
        } @else if (current.status === 'not-found') {
          <h1>Artigo não encontrado</h1>
          <p role="status">O artigo pode não existir ou não estar publicado.</p>
        } @else if (current.status === 'error') {
          <h1>Artigo indisponível</h1>
          <p role="alert">Não foi possível carregar este artigo agora. Tente novamente mais tarde.</p>
        } @else {
          <article class="public-article">
            <header>
              <p class="eyebrow">ARTIGO</p>
              <h1>{{ current.post.title }}</h1>
              <p class="article-meta">
                Publicado em
                <time [attr.datetime]="current.post.publishedAt">
                  {{ current.post.publishedAt | date: 'dd/MM/yyyy' }}
                </time>
              </p>
              @if (current.post.excerpt) {
                <p class="article-excerpt">{{ current.post.excerpt }}</p>
              }
            </header>
            <div class="article-body" data-testid="article-body">
              @for (block of current.post.body.blocks; track $index) {
                @if (block.type === 'paragraph') {
                  <p>{{ block.text }}</p>
                } @else if (block.type === 'heading') {
                  @if (block.level === 2) {
                    <h2>{{ block.text }}</h2>
                  } @else {
                    <h3>{{ block.text }}</h3>
                  }
                } @else if (block.type === 'quote') {
                  <blockquote>{{ block.text }}</blockquote>
                } @else if (block.type === 'list') {
                  <ul>
                    @for (item of block.items; track $index) {
                      <li>{{ item }}</li>
                    }
                  </ul>
                } @else if (block.type === 'image') {
                  <p class="article-media-placeholder" role="note">
                    Imagem indisponível: {{ block.alt }}
                  </p>
                }
              }
            </div>
          </article>
        }
      }
    </section>
  `,
})
export class PostDetailComponent {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);

  protected readonly state = toSignal(
    this.route.paramMap.pipe(
      map((parameters) => parameters.get('slug') ?? ''),
      distinctUntilChanged(),
      switchMap((slug) => this.http.get<PublicArticle>(
        '/api/public/posts/' + encodeURIComponent(slug),
      ).pipe(
        map((post): ArticleState => ({ status: 'ready', post })),
        catchError((error: unknown) => of<ArticleState>({
          status: error instanceof HttpErrorResponse && error.status === 404 ? 'not-found' : 'error',
        })),
        startWith({ status: 'loading' } as ArticleState),
      )),
    ),
    { initialValue: { status: 'loading' } as ArticleState },
  );
}
