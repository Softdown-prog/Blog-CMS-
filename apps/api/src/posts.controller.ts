import { Controller, Get, Param } from '@nestjs/common';
import { PostsService, PublicPost, PublicPostSummary } from './posts.service';

@Controller('public/posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  listPublic(): Promise<readonly PublicPostSummary[]> {
    return this.posts.listPublic();
  }

  @Get(':slug')
  getPublic(@Param('slug') slug: string): Promise<PublicPost> {
    return this.posts.getPublicBySlug(slug);
  }
}
