import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PostsController } from './posts.controller';

@Module({
  controllers: [HealthController, PostsController],
})
export class AppModule {}

