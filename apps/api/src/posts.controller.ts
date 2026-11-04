import { Controller, Get } from '@nestjs/common';

interface PublicPostSummary {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly publishedAt: string;
}

@Controller('public/posts')
export class PostsController {
  // Etapa 1: sem acesso ao banco, sem dados inventados e sem rotas de escrita.
  @Get()
  listPublic(): readonly PublicPostSummary[] {
    return [];
  }
}

