import 'reflect-metadata';
import 'dotenv/config';

import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';

import { AppModule } from './app.module';
import { getJwtSecret } from './core/auth/jwt';
import { disconnectPrisma } from './prisma';
import { UPLOAD_DIR } from './core/upload.config';
import { setupSwagger } from './swagger/swagger';

const server = express();

async function bootstrap() {
  // Fail-fast: sem JWT_SECRET o guard não consegue validar nada.
  getJwtSecret();

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(server),
  );

  // O default do Express é 100 KB, e o sync de formulário com vários itens
  // passa disso. Foto, porém, vai por multipart em /photos/upload — não é para
  // caber aqui como base64, por isso o limite segue modesto.
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { limit: '2mb', extended: true });

  // O front roda em outra origem — sem isso o browser bloqueia toda chamada.
  app.enableCors();

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Swagger UI em /api/docs e o spec cru em /api/docs.json.
  setupSwagger(app);

  // Em dev os uploads vão pro disco em public/uploads e são servidos aqui.
  // Na Vercel o diretório public/ é servido pela própria plataforma.
  server.use('/uploads', express.static(UPLOAD_DIR));

  // Fecha o pool do Postgres quando o processo recebe SIGINT/SIGTERM.
  app.enableShutdownHooks();
  for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sinal, () => {
      void disconnectPrisma().finally(() => process.exit(0));
    });
  }

  await app.init();

  return app;
}

const bootstrapped = bootstrap().catch((err) => {
  console.error('Nest bootstrap error:', err);
  throw err;
});

// Localmente sobe o servidor HTTP; na Vercel o app é importado como handler.
if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;

  bootstrapped
    .then(() => {
      server.listen(port, () => {
        console.log(`Server is running in http://localhost:${port}`);
      });
    })
    .catch(() => process.exit(1));
}

// Exporta o servidor Express compatível com @vercel/node
export default server;
