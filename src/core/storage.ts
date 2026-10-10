import { BadRequestException, Logger } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';

import { HttpError } from './httpError';
import { UPLOAD_DIR } from './upload.config';

const logger = new Logger('Storage');

const NA_VERCEL = !!process.env.VERCEL;
const TEM_TOKEN_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

// Aviso na subida, não na primeira foto: assim o problema aparece no log do
// deploy em vez de um aluno descobrir no meio do preenchimento do formulário.
// Vincular o Blob store ao projeto na Vercel injeta a variável — mas só vale
// em build novo, então é preciso refazer o deploy depois de vincular.
if (NA_VERCEL && !TEM_TOKEN_BLOB) {
  logger.error(
    'BLOB_READ_WRITE_TOKEN não configurado neste ambiente da Vercel: ' +
      'TODO upload de imagem vai falhar. Vincule o Blob store ao projeto ' +
      '(Storage → Connect Project) ou defina a variável em Settings → ' +
      'Environment Variables, e REFAÇA O DEPLOY.',
  );
}

/**
 * Traduz a falha do @vercel/blob em algo acionável.
 *
 * Sem isso, "Access denied, please provide a valid token for this resource"
 * chegava ao cliente como 500 "Erro interno do servidor" — e só era possível
 * descobrir a causa lendo o stack trace no log da Vercel.
 */
function traduzirErroDoBlob(e: any): HttpError {
  const nome = String(e?.name ?? '');
  const msg = String(e?.message ?? '');

  // Token ausente, inválido, expirado ou de outro store: configuração nossa.
  if (
    nome === 'BlobAccessError' ||
    nome === 'BlobClientTokenExpiredError' ||
    nome === 'BlobStoreNotFoundError' ||
    /access denied|valid token|not found/i.test(msg)
  ) {
    logger.error(
      `Vercel Blob recusou a credencial (${nome || 'sem nome'}): ${msg}. ` +
        'Confira BLOB_READ_WRITE_TOKEN no ambiente e refaça o deploy.',
    );
    return new HttpError(
      'Armazenamento de imagens não está configurado no servidor',
      503,
      { codigo: 'BLOB_MAL_CONFIGURADO' },
    );
  }

  if (nome === 'BlobStoreSuspendedError') {
    logger.error('Vercel Blob store suspenso.');
    return new HttpError('Armazenamento de imagens suspenso', 503, {
      codigo: 'BLOB_SUSPENSO',
    });
  }

  if (nome === 'BlobFileTooLargeError') {
    return new HttpError('Imagem grande demais para o armazenamento', 413, {
      codigo: 'IMAGEM_GRANDE',
    });
  }

  if (nome === 'BlobContentTypeNotAllowedError') {
    return new HttpError('Tipo de imagem não aceito pelo armazenamento', 400, {
      codigo: 'IMAGEM_TIPO_INVALIDO',
    });
  }

  logger.error(`Falha ao enviar a imagem para o Vercel Blob: ${nome} ${msg}`);
  return new HttpError('Não foi possível salvar a imagem. Tente novamente.', 502, {
    codigo: 'BLOB_INDISPONIVEL',
  });
}

// Transforma o arquivo recebido pelo multer numa URL persistida.
// Em prod (Vercel) sobe pro Blob; em dev o arquivo já está em public/uploads.
export async function persistUploadedFile(
  file: Express.Multer.File,
  prefix: string,
): Promise<string> {
  if (!file) {
    throw new BadRequestException('Arquivo é obrigatório');
  }

  if (!NA_VERCEL) {
    return `/uploads/${file.filename}`;
  }

  // Erro de configuração: responde antes de gastar a chamada ao Blob.
  if (!TEM_TOKEN_BLOB) {
    throw new HttpError('Armazenamento de imagens não está configurado no servidor', 503, {
      codigo: 'BLOB_MAL_CONFIGURADO',
    });
  }

  try {
    const { put } = await import('@vercel/blob');
    const blob = await put(`${prefix}/${Date.now()}-${file.originalname}`, file.buffer, {
      access: 'public',
      contentType: file.mimetype,
    });

    return blob.url;
  } catch (err: any) {
    if (err instanceof HttpError) throw err;
    throw traduzirErroDoBlob(err);
  }
}

// Best-effort cleanup do arquivo anterior (Blob ou disco).
// Nunca derruba o request se falhar.
export async function removeStoredFile(url: string | null | undefined): Promise<void> {
  if (!url) return;

  try {
    if (url.startsWith('http')) {
      const { del } = await import('@vercel/blob');
      await del(url);
      return;
    }

    if (url.startsWith('/uploads/')) {
      const filePath = path.resolve(UPLOAD_DIR, url.replace('/uploads/', ''));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  } catch (err) {
    logger.warn(`Falha ao remover arquivo anterior (${url}): ${(err as Error).message}`);
  }
}
