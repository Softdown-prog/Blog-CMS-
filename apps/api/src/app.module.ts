import { Module } from '@nestjs/common';
import { DatabaseLifecycle, databaseProvider } from './database';
import { HealthController } from './health.controller';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { EditorialHttpController, EditorialHttpService } from './editorial/editorial-http';
import { ScheduledPublisherWorker } from './editorial/application/scheduled-worker';
import { SiteContentService } from './site-content.service';
import { ButtonGadgetService, ButtonGadgetController } from './button-gadget';
import { PagesController, WidgetsController, PostViewsController, AdminSiteController } from './site-content.controller';
import { AdminAuthController, authProvider } from './security/admin-auth.controller';

@Module({
  controllers: [HealthController, PostsController, AdminAuthController, EditorialHttpController, PagesController, WidgetsController, PostViewsController, AdminSiteController, ButtonGadgetController],
  providers: [databaseProvider, DatabaseLifecycle, PostsService, SiteContentService, ButtonGadgetService, EditorialHttpService, ScheduledPublisherWorker, authProvider],
})
export class AppModule {}

